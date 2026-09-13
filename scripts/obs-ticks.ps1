$env:NODE_TLS_REJECT_UNAUTHORIZED = '0'
$log = @()
1..8 | ForEach-Object {
  $i = $_
  try {
    $t = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/city/tick' -Method POST -UseBasicParsing -TimeoutSec 120
    $j = $t.Content | ConvertFrom-Json
    $parts = @()
    foreach ($a in $j.acted) {
      $err = ''
      if ($a.error) {
        $msg = [string]$a.error
        $err = ' ERR=' + $msg.Substring(0, [Math]::Min(80, $msg.Length))
      }
      $place = $a.decision.target_place
      $arrow = if ($place) { '->' + $place } else { '' }
      $parts += "$($a.agent):$($a.decision.action)$arrow$err"
    }
    $acted = $parts -join ' | '
    $log += "T$i h=$($j.hour) #$($j.tick) $acted"
  } catch {
    $log += "T$i ERR $($_.Exception.Message)"
  }
  Start-Sleep -Seconds 2
}
$log -join "`n"
