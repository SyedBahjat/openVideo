// openvideo-speech: on-device speech recognition for the teleprompter's "Follow my voice" mode (macOS).
// Usage: openvideo-speech <locale> [hint words...]
// Prints one JSON object per line on stdout:
//   {"type":"status","state":"listening"|"denied"|"unavailable"|"error","message":"..."}
//   {"type":"heard","words":["last","few","words"]}
// Exits when stdin closes (the app quit or stopped listening).
import AVFoundation
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj), let line = String(data: data, encoding: .utf8) else { return }
    print(line)
}

func fail(_ state: String, _ message: String) -> Never {
    emit(["type": "status", "state": state, "message": message])
    exit(1)
}

let args = Array(CommandLine.arguments.dropFirst())
let locale = Locale(identifier: args.first ?? "en-US")
let hints = Array(args.dropFirst().prefix(100))

guard let recognizer = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer() else {
    fail("unavailable", "Speech recognition isn't available for \(locale.identifier).")
}

let engine = AVAudioEngine()
var request: SFSpeechAudioBufferRecognitionRequest?
var task: SFSpeechRecognitionTask?

// Recognition sessions end on their own (silence, time limits); start a fresh one each time.
func startTask() {
    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
    req.contextualStrings = hints
    request = req
    task = recognizer.recognitionTask(with: req) { result, error in
        if let result {
            emit(["type": "heard", "words": result.bestTranscription.segments.suffix(8).map { $0.substring }])
        }
        if error != nil || result?.isFinal == true {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                guard request === req else { return }
                req.endAudio()
                startTask()
            }
        }
    }
}

func startListening() {
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.channelCount > 0 else { fail("error", "No microphone found.") }
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request?.append(buffer) }
    engine.prepare()
    do { try engine.start() } catch { fail("error", "Couldn't start the microphone: \(error.localizedDescription)") }
    startTask()
    emit(["type": "status", "state": "listening", "onDevice": recognizer.supportsOnDeviceRecognition])
}

SFSpeechRecognizer.requestAuthorization { status in
    DispatchQueue.main.async {
        guard status == .authorized else {
            fail("denied", "Speech Recognition is turned off for openVideo in System Settings → Privacy & Security.")
        }
        AVCaptureDevice.requestAccess(for: .audio) { ok in
            DispatchQueue.main.async {
                if !ok { fail("denied", "Microphone access is turned off for openVideo.") }
                startListening()
            }
        }
    }
}

// The parent closes our stdin when it stops listening or quits; don't outlive it.
DispatchQueue.global().async {
    while readLine() != nil {}
    exit(0)
}

dispatchMain()
