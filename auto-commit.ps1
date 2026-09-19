# Auto-commit and push script for text-rpg-generator
# Watches for file changes and automatically commits + pushes to GitHub

$projectPath = "c:\Users\Administrator\Desktop\text-rpg-generator"
$remote = "text-rpg-generator"
$branch = "main"

Write-Host "🔍 Starting file watcher for: $projectPath" -ForegroundColor Cyan
Write-Host "📡 Remote: $remote/$branch" -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop.`n" -ForegroundColor Yellow

# Create file system watcher
$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = $projectPath
$watcher.IncludeSubdirectories = $true
$watcher.EnableRaisingEvents = $true
$watcher.NotifyFilter = [System.IO.NotifyFilters]::LastWrite -bor [System.IO.NotifyFilters]::FileName -bor [System.IO.NotifyFilters]::DirectoryName

# Ignore patterns
$ignorePatterns = @('.git', 'node_modules', '.env', '*.log', 'dist', 'build')

$pendingCommit = $false

$action = {
    $path = $Event.SourceEventArgs.FullPath
    $changeType = $Event.SourceEventArgs.ChangeType

    # Check ignore patterns
    foreach ($pattern in $ignorePatterns) {
        if ($path -like "*$pattern*") { return }
    }

    $script:pendingCommit = $true
    Write-Host "📝 Change detected: [$changeType] $(Split-Path $path -Leaf)" -ForegroundColor Gray
}

# Register event handlers
Register-ObjectEvent $watcher Changed -Action $action | Out-Null
Register-ObjectEvent $watcher Created -Action $action | Out-Null
Register-ObjectEvent $watcher Deleted -Action $action | Out-Null
Register-ObjectEvent $watcher Renamed -Action $action | Out-Null

# Main loop with debounce (wait 3 seconds after last change)
try {
    while ($true) {
        Start-Sleep -Seconds 3

        if ($script:pendingCommit) {
            $script:pendingCommit = $false

            # Check if there are actual git changes
            $status = git -C $projectPath status --porcelain 2>&1
            if ($status) {
                $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
                $commitMsg = "Auto-commit: $timestamp"

                Write-Host "`n⚡ Auto-committing changes..." -ForegroundColor Green

                git -C $projectPath add . 2>&1 | Out-Null
                git -C $projectPath commit -m $commitMsg 2>&1 | Out-Null
                Write-Host "✅ Committed: $commitMsg" -ForegroundColor Green

                $pushResult = git -C $projectPath push $remote $branch 2>&1
                if ($LASTEXITCODE -eq 0) {
                    Write-Host "🚀 Pushed to GitHub successfully!`n" -ForegroundColor Cyan
                } else {
                    Write-Host "⚠️  Push failed: $pushResult`n" -ForegroundColor Red
                }
            }
        }
    }
} finally {
    $watcher.EnableRaisingEvents = $false
    $watcher.Dispose()
    Get-EventSubscriber | Unregister-Event
    Write-Host "`n🛑 File watcher stopped." -ForegroundColor Yellow
}
