const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// --- 数据库初始化与安全读写 ---
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

function hashPassword(password, salt) {
    return crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function getInitialDb() {
    const adminSalt = crypto.randomBytes(16).toString('hex');
    const adminHash = hashPassword('admin123456', adminSalt);

    return {
        users: [],
        orders: [],
        admins: [
            {
                id: 'admin_1',
                username: 'admin',
                email: 'admin@rpg.local',
                salt: adminSalt,
                password_hash: adminHash,
                created_at: new Date().toISOString()
            }
        ],
        settings: {
            default_visitor_actions: 15,
            default_general_actions: 25,
            global_api_key: '',
            default_model: 'gemini-2.5-flash',
            custom_proxy_url: '',
            site_notice: '欢迎游玩 AI 文字冒险游戏产生器！新玩家注册即赠送 25 次行动。'
        },
        sessions: {}
    };
}

let dbCache = null;

function loadDb() {
    if (!fs.existsSync(DB_FILE)) {
        dbCache = getInitialDb();
        saveDb();
    } else {
        try {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            dbCache = JSON.parse(data);
        } catch (e) {
            console.error('Failed to parse DB, reinitializing:', e);
            dbCache = getInitialDb();
            saveDb();
        }
    }
    return dbCache;
}

function saveDb() {
    fs.writeFileSync(DB_FILE, JSON.stringify(dbCache, null, 2), 'utf8');
}

loadDb();

// --- 辅助工具函数 ---
function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
            if (body.length > 10 * 1024 * 1024) { // 10MB limit
                reject(new Error('Payload too large'));
            }
        });
        req.on('end', () => {
            if (!body.trim()) return resolve({});
            try {
                resolve(JSON.parse(body));
            } catch (e) {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}

function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key'
    });
    res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message) {
    sendJson(res, statusCode, { success: false, error: message });
}

function getAuthUser(req) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7);
    const session = dbCache.sessions[token];
    if (!session) return null;

    if (session.type === 'user') {
        const user = dbCache.users.find(u => u.id === session.userId);
        return user ? { ...user, token } : null;
    }
    return null;
}

function getAuthAdmin(req) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7);
    const session = dbCache.sessions[token];
    if (!session || session.type !== 'admin') return null;

    const admin = dbCache.admins.find(a => a.id === session.adminId);
    return admin ? { ...admin, token } : null;
}

// --- 静态资源 MIME 类型 ---
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.rpgsave': 'application/octet-stream'
};

// --- HTTP 请求处理器 ---
const server = http.createServer(async (req, res) => {
    // CORS 预检请求
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key'
        });
        return res.end();
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;

    // ==========================================
    // 1. 用户认证路由 (Auth APIs)
    // ==========================================
    if (pathname === '/api/auth/register' && req.method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const { email, password, nickname, sponsorEmail } = body;

            if (!email || !password) {
                return sendError(res, 400, '邮箱与密码为必填项');
            }
            if (password.length < 6) {
                return sendError(res, 400, '密码长度至少需 6 位');
            }

            const existingUser = dbCache.users.find(u => u.email.toLowerCase() === email.toLowerCase());
            if (existingUser) {
                return sendError(res, 400, '该邮箱已被注册');
            }

            const salt = crypto.randomBytes(16).toString('hex');
            const password_hash = hashPassword(password, salt);
            const newUser = {
                id: 'usr_' + crypto.randomBytes(8).toString('hex'),
                email: email.trim().toLowerCase(),
                nickname: (nickname || email.split('@')[0]).trim(),
                sponsorEmail: '',
                salt,
                password_hash,
                membershipTier: 'sponsor',
                maxActions: Infinity,
                actionsUsed: 0,
                dlc_custom_action: true,
                dlc_cartridge: true,
                created_at: new Date().toISOString()
            };

            dbCache.users.push(newUser);
            const token = generateToken();
            dbCache.sessions[token] = { type: 'user', userId: newUser.id, created_at: Date.now() };
            saveDb();

            const safeUser = { ...newUser };
            delete safeUser.salt;
            delete safeUser.password_hash;
            return sendJson(res, 200, { success: true, token, user: safeUser });
        } catch (e) {
            return sendError(res, 500, e.message);
        }
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const { email, password } = body;

            if (!email || !password) {
                return sendError(res, 400, '请输入邮箱与密码');
            }

            const user = dbCache.users.find(u => u.email.toLowerCase() === email.toLowerCase().trim());
            if (!user) {
                return sendError(res, 401, '账号不存在或密码错误');
            }

            const checkHash = hashPassword(password, user.salt);
            if (checkHash !== user.password_hash) {
                return sendError(res, 401, '账号不存在或密码错误');
            }

            const token = generateToken();
            dbCache.sessions[token] = { type: 'user', userId: user.id, created_at: Date.now() };
            saveDb();

            const safeUser = { ...user };
            delete safeUser.salt;
            delete safeUser.password_hash;
            return sendJson(res, 200, { success: true, token, user: safeUser });
        } catch (e) {
            return sendError(res, 500, e.message);
        }
    }

    if (pathname === '/api/auth/me' && req.method === 'GET') {
        const user = getAuthUser(req);
        if (!user) {
            // 游客身份默认权限
            return sendJson(res, 200, {
                success: true,
                isGuest: true,
                user: {
                    membershipTier: 'sponsor',
                    maxActions: Infinity,
                    actionsUsed: 0,
                    dlc_custom_action: true,
                    dlc_cartridge: true
                }
            });
        }
        const safeUser = { ...user };
        delete safeUser.salt;
        delete safeUser.password_hash;
        safeUser.membershipTier = 'sponsor';
        safeUser.maxActions = Infinity;
        safeUser.dlc_custom_action = true;
        safeUser.dlc_cartridge = true;
        return sendJson(res, 200, { success: true, isGuest: false, user: safeUser });
    }

    if (pathname === '/api/auth/action-step' && req.method === 'POST') {
        const user = getAuthUser(req);
        if (user) {
            user.actionsUsed = (user.actionsUsed || 0) + 1;
            saveDb();
            return sendJson(res, 200, { success: true, actionsUsed: user.actionsUsed, maxActions: user.maxActions });
        }
        return sendJson(res, 200, { success: true });
    }

    // ==========================================
    // 2. 赞助提交与核销路由 (Sponsorship APIs)
    // ==========================================
    if (pathname === '/api/sponsor/submit' && req.method === 'POST') {
        try {
            const user = getAuthUser(req);
            const body = await parseJsonBody(req);
            const { sponsorEmail, transactionId, dlcType } = body;

            if (!transactionId || transactionId.trim().length < 6) {
                return sendError(res, 400, '请输入有效的交易单号 (Transaction ID)');
            }

            const cleanTxId = transactionId.trim();
            // 查重：检查该单号是否已经被他人使用
            const existingOrder = dbCache.orders.find(o => o.transaction_id === cleanTxId);
            if (existingOrder && existingOrder.user_id !== (user ? user.id : 'guest')) {
                return sendError(res, 400, '该交易单号已被提交使用');
            }

            const newOrder = {
                id: 'ord_' + crypto.randomBytes(6).toString('hex'),
                user_id: user ? user.id : 'guest',
                user_email: user ? user.email : (sponsorEmail || 'unknown'),
                user_nickname: user ? user.nickname : '游客',
                sponsor_email: (sponsorEmail || (user ? user.sponsorEmail : '')).trim(),
                transaction_id: cleanTxId,
                dlc_type: dlcType || 'sponsor_membership',
                amount: dlcType === 'dlc_both' ? 15 : (dlcType?.startsWith('dlc_') ? 10 : 5),
                status: 'pending', // pending, approved, rejected
                created_at: new Date().toISOString(),
                reviewed_at: null
            };

            if (existingOrder) {
                Object.assign(existingOrder, newOrder);
            } else {
                dbCache.orders.unshift(newOrder);
            }

            // 更新用户自己的 sponsorEmail 记录
            if (user && sponsorEmail) {
                user.sponsorEmail = sponsorEmail.trim();
                user.lastTransactionId = cleanTxId;
            }
            saveDb();

            return sendJson(res, 200, {
                success: true,
                message: '赞助单号已成功提交，管理员将在审核后为您开通！',
                order: newOrder
            });
        } catch (e) {
            return sendError(res, 500, e.message);
        }
    }

    if (pathname === '/api/sponsor/status' && req.method === 'GET') {
        const user = getAuthUser(req);
        if (!user) {
            return sendError(res, 401, '请先登录以查看赞助开通状态');
        }

        const approvedOrder = dbCache.orders.find(o => o.user_id === user.id && o.status === 'approved');
        const pendingOrder = dbCache.orders.find(o => o.user_id === user.id && o.status === 'pending');

        return sendJson(res, 200, {
            success: true,
            membershipTier: user.membershipTier,
            maxActions: user.maxActions,
            dlc_custom_action: user.dlc_custom_action,
            dlc_cartridge: user.dlc_cartridge,
            isApproved: user.membershipTier === 'sponsor',
            hasPending: !!pendingOrder,
            pendingOrder: pendingOrder || null
        });
    }

    // ==========================================
    // 3. 运营管理后台路由 (Admin APIs)
    // ==========================================
    if (pathname === '/api/admin/login' && req.method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const { username, password } = body;

            const admin = dbCache.admins.find(a => a.username === username || a.email === username);
            if (!admin) {
                return sendError(res, 401, '管理员账号或密码错误');
            }

            const checkHash = hashPassword(password, admin.salt);
            if (checkHash !== admin.password_hash) {
                return sendError(res, 401, '管理员账号或密码错误');
            }

            const token = 'adm_' + generateToken();
            dbCache.sessions[token] = { type: 'admin', adminId: admin.id, created_at: Date.now() };
            saveDb();

            return sendJson(res, 200, {
                success: true,
                token,
                admin: { username: admin.username, email: admin.email }
            });
        } catch (e) {
            return sendError(res, 500, e.message);
        }
    }

    if (pathname === '/api/admin/stats' && req.method === 'GET') {
        const admin = getAuthAdmin(req);
        if (!admin) return sendError(res, 403, '权限不足，请先登录管理员后台');

        const totalUsers = dbCache.users.length;
        const totalSponsors = dbCache.users.filter(u => u.membershipTier === 'sponsor').length;
        const pendingOrders = dbCache.orders.filter(o => o.status === 'pending').length;
        const totalActions = dbCache.users.reduce((acc, u) => acc + (u.actionsUsed || 0), 0);

        return sendJson(res, 200, {
            success: true,
            stats: {
                totalUsers,
                totalSponsors,
                pendingOrders,
                totalActions,
                totalOrders: dbCache.orders.length
            }
        });
    }

    if (pathname === '/api/admin/orders' && req.method === 'GET') {
        const admin = getAuthAdmin(req);
        if (!admin) return sendError(res, 403, '权限不足');

        const statusFilter = parsedUrl.searchParams.get('status');
        let orders = dbCache.orders;
        if (statusFilter && statusFilter !== 'all') {
            orders = orders.filter(o => o.status === statusFilter);
        }

        return sendJson(res, 200, { success: true, orders });
    }

    if (pathname === '/api/admin/orders/review' && req.method === 'POST') {
        const admin = getAuthAdmin(req);
        if (!admin) return sendError(res, 403, '权限不足');

        try {
            const body = await parseJsonBody(req);
            const { orderId, action, grantTier, grantCustomActionDlc, grantCartridgeDlc } = body;

            const order = dbCache.orders.find(o => o.id === orderId);
            if (!order) return sendError(res, 404, '找不到该赞助工单');

            const targetUser = dbCache.users.find(u => u.id === order.user_id || u.email === order.user_email);

            if (action === 'approve') {
                order.status = 'approved';
                order.reviewed_at = new Date().toISOString();

                if (targetUser) {
                    targetUser.membershipTier = grantTier || 'sponsor';
                    targetUser.maxActions = targetUser.membershipTier === 'sponsor' ? Infinity : 50;
                    if (grantCustomActionDlc !== undefined) targetUser.dlc_custom_action = !!grantCustomActionDlc;
                    if (grantCartridgeDlc !== undefined) targetUser.dlc_cartridge = !!grantCartridgeDlc;
                }
            } else if (action === 'reject') {
                order.status = 'rejected';
                order.reviewed_at = new Date().toISOString();
            } else {
                return sendError(res, 400, '未知操作');
            }

            saveDb();
            return sendJson(res, 200, { success: true, order, targetUser });
        } catch (e) {
            return sendError(res, 500, e.message);
        }
    }

    if (pathname === '/api/admin/users' && req.method === 'GET') {
        const admin = getAuthAdmin(req);
        if (!admin) return sendError(res, 403, '权限不足');

        const q = (parsedUrl.searchParams.get('q') || '').toLowerCase().trim();
        let users = dbCache.users;
        if (q) {
            users = users.filter(u => u.email.toLowerCase().includes(q) || u.nickname.toLowerCase().includes(q));
        }

        const safeUsers = users.map(u => {
            const copy = { ...u };
            delete copy.salt;
            delete copy.password_hash;
            return copy;
        });

        return sendJson(res, 200, { success: true, users: safeUsers });
    }

    if (pathname === '/api/admin/users/update' && req.method === 'POST') {
        const admin = getAuthAdmin(req);
        if (!admin) return sendError(res, 403, '权限不足');

        try {
            const body = await parseJsonBody(req);
            const { userId, membershipTier, maxActions, dlc_custom_action, dlc_cartridge } = body;

            const user = dbCache.users.find(u => u.id === userId);
            if (!user) return sendError(res, 404, '未找到该用户');

            if (membershipTier !== undefined) user.membershipTier = membershipTier;
            if (maxActions !== undefined) user.maxActions = maxActions === 'Infinity' ? Infinity : parseInt(maxActions, 10);
            if (dlc_custom_action !== undefined) user.dlc_custom_action = !!dlc_custom_action;
            if (dlc_cartridge !== undefined) user.dlc_cartridge = !!dlc_cartridge;

            saveDb();
            return sendJson(res, 200, { success: true, user });
        } catch (e) {
            return sendError(res, 500, e.message);
        }
    }

    if (pathname === '/api/admin/settings' && req.method === 'GET') {
        const admin = getAuthAdmin(req);
        if (!admin) return sendError(res, 403, '权限不足');
        return sendJson(res, 200, { success: true, settings: dbCache.settings });
    }

    if (pathname === '/api/admin/settings' && req.method === 'POST') {
        const admin = getAuthAdmin(req);
        if (!admin) return sendError(res, 403, '权限不足');

        try {
            const body = await parseJsonBody(req);
            Object.assign(dbCache.settings, body);
            saveDb();
            return sendJson(res, 200, { success: true, settings: dbCache.settings });
        } catch (e) {
            return sendError(res, 500, e.message);
        }
    }

    // ==========================================
    // 4. 智能 AI 网关代理路由 (AI Gateway)
    // ==========================================
    if (pathname === '/api/ai/chat' && req.method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            let { prompt, model, apiKey, isJson, safetySettings, selectedChoice, playerState } = body;

            const activeKey = (apiKey || dbCache.settings.global_api_key || process.env.GEMINI_API_KEY || '').trim();
            if (!activeKey) {
                return sendError(res, 400, '未配置 API Key，请在前端设置中填写金钥或由管理员配置全局 Key');
            }

            const activeModel = model || dbCache.settings.default_model || 'gemini-2.5-flash';

            // --- 選擇後果與隨機判定系統核心 (Backend Outcome Interception System) ---
            let sysMessage = "";
            let outcomeCalculated = null;

            if (playerState) {
                // 確保 world_state 存在
                if (!playerState.world_state) {
                    playerState.world_state = { npc_favor: {}, flags: {}, decisions: [] };
                }

                // A. 如果玩家進行了具有「判定 (check)」的選項
                if (selectedChoice && selectedChoice.check) {
                    const check = selectedChoice.check;
                    const attrName = check.attribute || 'strength';
                    const DC = parseInt(check.difficulty || '10', 10);
                    const requiredItem = check.required_item;
                    const requiredNPC = check.required_favor_npc;
                    const requiredNPCVal = parseInt(check.required_favor_value || '0', 10);

                    // 1. 取得玩家屬性值與調整值
                    const attrVal = playerState.player_status?.attributes?.[attrName] || 10;
                    const modifier = Math.floor((attrVal - 10) / 2);

                    // 2. 檢查前置物品加成或判定
                    let hasItem = false;
                    if (playerState.player_status?.inventory) {
                        hasItem = playerState.player_status.inventory.some(item => {
                            const name = typeof item === 'string' ? item : (item.name || '');
                            return name.toLowerCase().includes((requiredItem || '').toLowerCase());
                        });
                    }
                    const itemBonus = hasItem ? 3 : 0;

                    // 3. 骰 d20 并計算總分
                    const roll = Math.floor(Math.random() * 20) + 1;
                    const score = roll + modifier + itemBonus;

                    // 4. 判定 5 檔結果
                    let tier = 'Success';
                    let tierZh = '成功 (Success)';

                    if (roll === 20 || score >= DC + 6) {
                        tier = 'CriticalSuccess';
                        tierZh = '大成功 (Critical Success)';
                    } else if (roll === 1 || score < DC - 7) {
                        tier = 'CriticalFailure';
                        tierZh = '大失敗 (Critical Failure)';
                    } else if (score >= DC) {
                        tier = 'Success';
                        tierZh = '成功 (Success)';
                    } else if (score >= DC - 3) {
                        tier = 'BarelySuccess';
                        tierZh = '勉強成功 (Barely Success)';
                    } else {
                        tier = 'Failure';
                        tierZh = '失敗 (Failure)';
                    }

                    // 5. 更新世界狀態與玩家記錄
                    if (selectedChoice.action) {
                        playerState.world_state.flags[selectedChoice.action] = tier;
                    }
                    
                    if (requiredNPC) {
                        if (!playerState.world_state.npc_favor[requiredNPC]) {
                            playerState.world_state.npc_favor[requiredNPC] = 0;
                        }
                        if (tier === 'CriticalSuccess') playerState.world_state.npc_favor[requiredNPC] += 10;
                        else if (tier === 'Success') playerState.world_state.npc_favor[requiredNPC] += 5;
                        else if (tier === 'Failure') playerState.world_state.npc_favor[requiredNPC] -= 5;
                        else if (tier === 'CriticalFailure') playerState.world_state.npc_favor[requiredNPC] -= 15;
                    }

                    // 記錄決策歷史
                    if (!playerState.world_state.decisions) playerState.world_state.decisions = [];
                    playerState.world_state.decisions.push({
                        action: selectedChoice.action || 'Unknown',
                        text: selectedChoice.text || 'Unknown Action',
                        result: tierZh,
                        roll: `d20:${roll} + Mod:${modifier} + Item:${itemBonus} = ${score} vs DC:${DC}`,
                        turn: playerState.world_state.decisions.length + 1
                    });

                    // 6. 建構強制 AI 的敘事指令
                    sysMessage = `
🔴 SYSTEM AUTHORITATIVE OUTCOME DETERMINATION (CRITICAL DO NOT CHANGE) 🔴
The player clicked choice: "${selectedChoice.text}" (Action: "${selectedChoice.action}").
The backend has calculated the dice roll and determined the outcome:
- Roll: d20 rolled a ${roll}.
- Checked Attribute: "${attrName}" (Player Value: ${attrVal}, Modifier: +${modifier}).
- Item Assist: Required "${requiredItem || 'None'}" (Possessed: ${hasItem ? 'Yes (+3)' : 'No (+0)'}).
- Difficulty Target (DC): ${DC}.
- Final Calculated Score: ${score}.
- **DETERMINED OUTCOME TIER**: **${tier}** (${tierZh}).

You MUST write the narrative strictly conforming to the outcome "**${tier}**" and update the JSON structure according to these consequences:
1. **CriticalSuccess (大成功)**: Complete, spectacular success! Describe the player overcoming the challenge flawlessly. Give extra positive flavor and maybe a rare item in "new_items".
2. **Success (成功)**: Standard clean success. They achieve their goal safely.
3. **BarelySuccess (勉強成功)**: Narrow, desperate success. They pass but pay a small price. You MUST deduct 5-10 HP, SP, or MP in "status_updates" (e.g. { "name": "生命力", "change": -10 }).
4. **Failure (失敗)**: They fail. The situation worsens. Deduct 15-20 HP or resource bar in "status_updates". Describe injury, setbacks, loss of items (if any in "removed_items"), or hostile NPC reaction.
5. **CriticalFailure (大失敗)**: Catastrophic failure. Deduct 25-35 HP or trigger immediate combat in "start_combat" with rank "Elite" or "Boss". Describe a major tragedy (e.g., equipment breaking, major structural collapse, ambush).

Your JSON "status_updates" or "new_items" / "removed_items" or "start_combat" MUST strictly reflect this outcome. Do NOT pretend they succeeded if they failed!
`;
                    outcomeCalculated = {
                        roll,
                        modifier,
                        itemBonus,
                        score,
                        DC,
                        tier,
                        tierZh
                    };
                }

                // B. 將世界狀態、決策歷史、好感度、據點與章節進度注入 AI 背景 Prompt 中
                const decisions = playerState.world_state.decisions || [];
                const npc_favor = playerState.world_state.npc_favor || {};
                const flags = playerState.world_state.flags || {};
                
                // Extract camp upgrades and chapter pacing metrics
                const camp = playerState.camp_state || { days: 1, chapter: 1, upgrades: { weapon: 0, armor: 0 }, blessings: [], unlocked_terminals: [] };
                const npcStates = playerState.npc_state || {};
                
                // Sync favors from npc_state to npc_favor for safety
                Object.keys(npcStates).forEach(npcKey => {
                    const n = npcStates[npcKey];
                    if (n && typeof n.favor === 'number') {
                        npc_favor[npcKey] = n.favor;
                    }
                });

                let historyPrompt = `
--- CAMP & PROGRESS WORLD STATE (CRITICAL CONTEXT) ---
- Base Camp Status:
  * Survival Days Elapsed: Day ${camp.days}
  * Active Story Chapter: Chapter ${camp.chapter}
  * Weapon Upgrade Level: +${camp.upgrades?.weapon || 0}
  * Armor Upgrade Level: +${camp.upgrades?.armor || 0}
  * Active Shrine Blessings: ${camp.blessings?.join(', ') || 'None'}
  * Old Terminals Unlocked: ${camp.unlocked_terminals?.length || 0}/3
- NPC Relationships (Favor & Alliances):
${Object.entries(npc_favor).map(([npc, val]) => `  * ${npc}: ${val}% favorability`).join('\n') || '  * (No custom NPC favor record yet)'}

- Past Choices & Outcomes:
${decisions.map(d => `  * Turn ${d.turn}: "${d.text}" -> ${d.result} (${d.roll})`).join('\n') || '  * (No actions recorded yet)'}
- World Flags (Active states):
${Object.entries(flags).map(([f, val]) => `  * Flag [${f}]: ${val}`).join('\n') || '  * (No world flags active yet)'}

Please reflect the player's Chapter Progress, Weapon/Armor tier, Active Blessings, and NPC relationship levels directly in the narrative events, dialogue variations, merchant pricing offers, and challenge outcomes!
--------------------------------------------
`;
                prompt = historyPrompt + (sysMessage ? sysMessage + "\n" : "") + prompt;
            }

            const successResponse = (contentStr) => {
                return sendJson(res, 200, { 
                    success: true, 
                    content: contentStr,
                    outcomeCalculated,
                    playerState
                });
            };

            // 智能判断 Key 类型：
            // A. Google 官方原生 Key (以 AIzaSy 开头)
            if (activeKey.startsWith('AIzaSy')) {
                const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent?key=${activeKey}`;
                const payload = {
                    contents: [{ parts: [{ text: prompt }] }]
                };
                if (safetySettings) payload.safetySettings = safetySettings;

                const response = await fetch(targetUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) {
                    const errText = await response.text();
                    return sendError(res, response.status, `Google API 错误: ${errText}`);
                }

                const result = await response.json();
                const content = result.candidates?.[0]?.content?.parts?.[0]?.text || '';
                return successResponse(content);
            }

            // B. 针对第三方转发、OpenAI 格式或代理 Key (例如用户提供的 AQ.Ab8... / sk-...)
            const proxyBase = dbCache.settings.custom_proxy_url || 'https://generativelanguage.googleapis.com';
            
            // 尝试 1: 如果是第三方代理兼容 OpenAI Chat Completions 规范
            if (proxyBase.includes('/v1') || activeKey.startsWith('sk-') || activeKey.startsWith('AQ.')) {
                let openaiEndpoint = proxyBase.endsWith('/') ? `${proxyBase}chat/completions` : `${proxyBase}/chat/completions`;
                if (!proxyBase.includes('/v1')) {
                    openaiEndpoint = 'https://api.openai.com/v1/chat/completions';
                }

                try {
                    const response = await fetch(openaiEndpoint, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${activeKey}`
                        },
                        body: JSON.stringify({
                            model: activeModel.includes('gemini') ? 'gpt-4o-mini' : activeModel,
                            messages: [{ role: 'user', content: prompt }],
                            temperature: 0.7
                        })
                    });

                    if (response.ok) {
                        const result = await response.json();
                        const content = result.choices?.[0]?.message?.content || '';
                        return successResponse(content);
                    }
                } catch (e) {
                    console.warn('OpenAI proxy attempt failed, falling back to direct gemini fetch:', e.message);
                }
            }

            // 尝试 2: 标准带 Header 转发 Gemini API
            const directGeminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent`;
            const geminiRes = await fetch(directGeminiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': activeKey
                },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }]
                })
            });

            if (!geminiRes.ok) {
                const errText = await geminiRes.text();
                return sendError(res, geminiRes.status, `AI 生成失败 (${geminiRes.status}): ${errText}`);
            }

            const geminiData = await geminiRes.json();
            const geminiContent = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
            return successResponse(geminiContent);

        } catch (e) {
            return sendError(res, 500, 'AI 网关转发异常: ' + e.message);
        }
    }

    // ==========================================
    // 5. 静态资源托管服务 (Static File Server)
    // ==========================================
    let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

    // 快捷路由: /admin 直接映射到 /admin.html
    if (pathname === '/admin') {
        filePath = path.join(PUBLIC_DIR, 'admin.html');
    }

    // 安全检查，防止路径穿越
    if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        return res.end('Forbidden');
    }

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            // 404  fallback
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('404 Not Found');
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        res.writeHead(200, { 'Content-Type': contentType });
        const readStream = fs.createReadStream(filePath);
        readStream.pipe(res);
    });
});

server.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`🚀 Text RPG Generator 服务启动成功!`);
    console.log(`🎮 游戏前台: http://localhost:${PORT}`);
    console.log(`🛠️ 管理后台: http://localhost:${PORT}/admin.html`);
    console.log(`🔑 默认管理员账号: admin / 密码: admin123456`);
    console.log(`=======================================================`);
});
