//! Live speech-to-text for "Search or Ask", using Windows' own dictation engine
//! (Windows.Media.SpeechRecognition, the same one as Win+H). Words appear in the search
//! field as you speak ("speech://partial"), and on stop the finished text is sent as a
//! normal typed question. It needs Windows' "Online speech recognition" privacy setting;
//! when that's off (or the language isn't supported) the app falls back to sending the
//! recording to Gemini instead.

use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;
use tauri::AppHandle;

enum Cmd {
    Stop,
    Cancel,
}

struct Live {
    cmd: Sender<Cmd>,
    done: Receiver<String>,
}

static LIVE: Mutex<Option<Live>> = Mutex::new(None);

/// Start dictation. Err(reason) when Windows can't do it, so the app uses its fallback.
#[tauri::command]
pub async fn speech_start(app: AppHandle) -> Result<(), String> {
    if let Some(old) = LIVE.lock().unwrap().take() {
        let _ = old.cmd.send(Cmd::Cancel);
    }
    let (cmd_tx, cmd_rx) = channel::<Cmd>();
    let (ready_tx, ready_rx) = channel::<Result<(), String>>();
    let (done_tx, done_rx) = channel::<String>();
    std::thread::spawn(move || imp::run(app, cmd_rx, ready_tx, done_tx));
    let ready = tauri::async_runtime::spawn_blocking(move || ready_rx.recv_timeout(Duration::from_secs(6)))
        .await
        .map_err(|e| e.to_string())?;
    match ready {
        Ok(Ok(())) => {
            *LIVE.lock().unwrap() = Some(Live { cmd: cmd_tx, done: done_rx });
            Ok(())
        }
        Ok(Err(e)) => {
            crate::log_line(format!("speech: unavailable: {e}"));
            Err(e)
        }
        Err(_) => {
            let _ = cmd_tx.send(Cmd::Cancel);
            crate::log_line("speech: dictation didn't start in time".into());
            Err("Windows dictation didn't start.".into())
        }
    }
}

/// Finish dictation and return everything that was recognised ("" if nothing).
#[tauri::command]
pub async fn speech_stop() -> String {
    let Some(live) = LIVE.lock().unwrap().take() else { return String::new() };
    let _ = live.cmd.send(Cmd::Stop);
    tauri::async_runtime::spawn_blocking(move || live.done.recv_timeout(Duration::from_secs(5)).unwrap_or_default())
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub fn speech_cancel() {
    if let Some(live) = LIVE.lock().unwrap().take() {
        let _ = live.cmd.send(Cmd::Cancel);
    }
}

#[cfg(windows)]
mod imp {
    use super::Cmd;
    use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tauri::{AppHandle, Emitter};
    use windows::core::{Ref, HSTRING};
    use windows::Foundation::TypedEventHandler;
    use windows::Media::SpeechRecognition::{
        SpeechContinuousRecognitionResultGeneratedEventArgs, SpeechContinuousRecognitionSession, SpeechRecognitionHypothesisGeneratedEventArgs,
        SpeechRecognitionResultStatus, SpeechRecognitionScenario, SpeechRecognitionTopicConstraint, SpeechRecognizer,
    };

    fn join(a: &str, b: &str) -> String {
        format!("{a} {b}").trim().to_string()
    }

    fn why(status: SpeechRecognitionResultStatus) -> String {
        match status {
            SpeechRecognitionResultStatus::TopicLanguageNotSupported => "Windows dictation doesn't support your speech language.".into(),
            SpeechRecognitionResultStatus::NetworkFailure => "Windows dictation needs an internet connection.".into(),
            SpeechRecognitionResultStatus::MicrophoneUnavailable => "The microphone isn't available.".into(),
            s => format!("Windows dictation isn't available (status {}).", s.0),
        }
    }

    pub fn run(app: AppHandle, cmd: Receiver<Cmd>, ready: Sender<Result<(), String>>, done: Sender<String>) {
        unsafe {
            use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let setup = || -> windows::core::Result<(SpeechRecognizer, SpeechRecognitionResultStatus)> {
            let rec = SpeechRecognizer::new()?;
            let topic = SpeechRecognitionTopicConstraint::Create(SpeechRecognitionScenario::Dictation, &HSTRING::from("dictation"))?;
            rec.Constraints()?.Append(&topic)?;
            let compiled = rec.CompileConstraintsAsync()?.get()?;
            Ok((rec, compiled.Status()?))
        };
        let rec = match setup() {
            Ok((rec, s)) if s == SpeechRecognitionResultStatus::Success => rec,
            Ok((_, s)) => {
                let _ = ready.send(Err(why(s)));
                return;
            }
            Err(e) => {
                // 0x80045509: "Online speech recognition" is off in Settings → Privacy → Speech.
                let msg = if e.code().0 as u32 == 0x8004_5509 {
                    "Windows' online speech recognition is turned off (Settings → Privacy & security → Speech).".to_string()
                } else {
                    format!("Windows dictation isn't available ({e}).")
                };
                let _ = ready.send(Err(msg));
                return;
            }
        };

        // Finished phrases, and the phrase still being spoken.
        let committed = Arc::new(Mutex::new(String::new()));
        let emit_text = {
            let app = app.clone();
            move |t: String| {
                let _ = app.emit("speech://partial", t);
            }
        };

        let started = (|| -> windows::core::Result<SpeechContinuousRecognitionSession> {
            let c1 = committed.clone();
            let e1 = emit_text.clone();
            rec.HypothesisGenerated(&TypedEventHandler::<SpeechRecognizer, SpeechRecognitionHypothesisGeneratedEventArgs>::new(
                move |_, args: Ref<SpeechRecognitionHypothesisGeneratedEventArgs>| {
                    if let Some(a) = args.as_ref() {
                        let h = a.Hypothesis()?.Text()?.to_string();
                        let base = c1.lock().unwrap().clone();
                        e1(join(&base, &h));
                    }
                    Ok(())
                },
            ))?;
            let session = rec.ContinuousRecognitionSession()?;
            let c2 = committed.clone();
            let e2 = emit_text.clone();
            session.ResultGenerated(&TypedEventHandler::<SpeechContinuousRecognitionSession, SpeechContinuousRecognitionResultGeneratedEventArgs>::new(
                move |_, args: Ref<SpeechContinuousRecognitionResultGeneratedEventArgs>| {
                    if let Some(a) = args.as_ref() {
                        let r = a.Result()?;
                        if r.Status()? == SpeechRecognitionResultStatus::Success {
                            let t = r.Text()?.to_string();
                            if !t.trim().is_empty() {
                                let mut g = c2.lock().unwrap();
                                *g = join(&g, &t);
                                e2(g.clone());
                            }
                        }
                    }
                    Ok(())
                },
            ))?;
            session.StartAsync()?.get()?;
            Ok(session)
        })();
        let session = match started {
            Ok(s) => s,
            Err(e) => {
                let msg = if e.code().0 as u32 == 0x8004_5509 {
                    "Windows' online speech recognition is turned off (Settings → Privacy & security → Speech).".to_string()
                } else {
                    format!("Windows dictation couldn't start ({e}).")
                };
                let _ = ready.send(Err(msg));
                return;
            }
        };
        crate::log_line("speech: Windows dictation listening".into());
        let _ = ready.send(Ok(()));

        // Wait for the app to stop (or cancel) us; never longer than the 30 s voice limit.
        let stop = match cmd.recv_timeout(Duration::from_secs(35)) {
            Ok(Cmd::Stop) | Err(RecvTimeoutError::Timeout) => true,
            Ok(Cmd::Cancel) | Err(RecvTimeoutError::Disconnected) => false,
        };
        if stop {
            // Stopping finalises the phrase in progress (ResultGenerated fires for it first).
            let _ = session.StopAsync().and_then(|a| a.get());
        } else {
            let _ = session.CancelAsync().and_then(|a| a.get());
        }
        let text = if stop { committed.lock().unwrap().clone() } else { String::new() };
        crate::log_line(format!("speech: dictation ended ({} chars)", text.len()));
        let _ = done.send(text);
        drop(rec);
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Cmd;
    use std::sync::mpsc::{Receiver, Sender};
    use tauri::AppHandle;
    pub fn run(_: AppHandle, _: Receiver<Cmd>, ready: Sender<Result<(), String>>, _: Sender<String>) {
        let _ = ready.send(Err("Dictation needs Windows.".into()));
    }
}
