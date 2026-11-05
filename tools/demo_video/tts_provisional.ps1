# 仮の説明音声（Windows標準の音声合成）を作る。ユーザーの録音がそろうまでの開発用。
# 出力：<repo>/local_media/voice_provisional/E1.wav ...（録音の置き場所 local_media/voice/ とは分ける）
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Resolve-Path (Join-Path $here '..\..')
$out = Join-Path $repo 'local_media\voice_provisional'
New-Item -ItemType Directory -Force $out | Out-Null
$script = Get-Content (Join-Path $here 'script_v2.json') -Raw -Encoding UTF8 | ConvertFrom-Json
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$ja = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'ja-JP' } | Select-Object -First 1
if ($null -eq $ja) { throw '日本語の音声（ja-JP）が見つかりません' }
$s.SelectVoice($ja.VoiceInfo.Name)
$s.Rate = 0
foreach ($line in $script.lines) {
  $f = Join-Path $out ($line.id + '.wav')
  $s.SetOutputToWaveFile($f)
  $s.Speak($line.text)
  $s.SetOutputToNull()
  Write-Output ("wrote " + $f)
}
Write-Output ("voice: " + $ja.VoiceInfo.Name)
