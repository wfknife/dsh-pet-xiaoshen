# deskpet - Hearing sensor helper (H0)
# Reads Windows media session (SMTC) METADATA only. No audio capture, no file writes.
# Emits one compact JSON line to stdout every PollMs milliseconds.
# Long-lived: spawned once by the main process; exits when the parent closes the pipe.
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI, so
# non-ASCII comments can corrupt parsing (e.g. swallow the param() block).
param([int]$PollMs = 5000, [int]$ParentPid = 0)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]

# WinRT async -> sync
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $type) {
  $m = $asTaskGeneric.MakeGenericMethod($type)
  $task = $m.Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

$sleepMs = 5000
if ($PSBoundParameters.ContainsKey('PollMs') -and $PollMs -gt 0) { $sleepMs = [int]$PollMs }

$mgr = $null
try {
  $mgrOp = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()
  $mgr = Await $mgrOp ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
} catch {
  $err = @{ ok = $false; ts = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()); error = 'manager_init_failed'; sessions = @() }
  ($err | ConvertTo-Json -Compress -Depth 4) -replace "`r?`n", ''
  [Console]::Out.Flush()
  exit 1
}

while ($true) {
  # Orphan guard: exit as soon as the owning app process is gone (hard-kill safe)
  if ($ParentPid -gt 0) {
    $alive = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
    if (-not $alive) { break }
  }
  $out = @{
    ok       = $true
    ts       = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    sessions = @()
  }
  try {
    foreach ($s in $mgr.GetSessions()) {
      $status = ''
      try { $status = [string]$s.GetPlaybackInfo().PlaybackStatus } catch { $status = 'Unknown' }
      $title = ''; $artist = ''; $album = ''; $mediaType = ''
      try {
        $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
        if ($props) {
          $title = [string]$props.Title
          $artist = [string]$props.Artist
          $album = [string]$props.AlbumTitle
          $mediaType = [string]$props.PlaybackType
        }
      } catch { }
      $out.sessions += @{
        app    = [string]$s.SourceAppUserModelId
        status = $status
        title  = $title
        artist = $artist
        album  = $album
        mediaType = $mediaType
      }
    }
  } catch {
    $out.ok = $false
    $out.error = [string]$_.Exception.Message
  }
  ($out | ConvertTo-Json -Compress -Depth 4) -replace "`r?`n", ''
  [Console]::Out.Flush()
  [System.Threading.Thread]::Sleep($sleepMs)
}
