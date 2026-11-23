# openVideo teleprompter, "Follow my voice" on Windows (beta).
# Uses the offline Windows speech recognizer (System.Speech). Same stdout protocol as speech-mac.swift:
#   {"type":"status","state":"listening"|"unavailable","message":"..."}
#   {"type":"heard","words":["last","few","words"]}
param([string]$Locale = 'en-US')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

try {
  Add-Type -AssemblyName System.Speech
  try { $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine ([System.Globalization.CultureInfo]::new($Locale)) }
  catch { $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine }
  $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $engine.SetInputToDefaultAudioDevice()
} catch {
  Emit @{ type = 'status'; state = 'unavailable'; message = "Windows speech recognition isn't set up on this PC ($($_.Exception.Message))." }
  exit 1
}

Register-ObjectEvent -InputObject $engine -EventName SpeechHypothesized -SourceIdentifier ov.hyp | Out-Null
Register-ObjectEvent -InputObject $engine -EventName SpeechRecognized -SourceIdentifier ov.rec | Out-Null
$engine.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
Emit @{ type = 'status'; state = 'listening' }

while ($true) {
  $e = Wait-Event -Timeout 5
  if (-not $e) { continue }
  $text = $e.SourceEventArgs.Result.Text
  Remove-Event -EventIdentifier $e.EventIdentifier
  if ($text) { Emit @{ type = 'heard'; words = @($text -split '\s+' | Select-Object -Last 8) } }
}
