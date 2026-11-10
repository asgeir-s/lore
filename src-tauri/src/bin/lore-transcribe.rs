//! Run the same pipeline as the app without modifying a note.
use lore_lib::transcription::{transcribe, TranscriptionLanguage};
use std::path::Path;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if !(2..=3).contains(&args.len()) {
        eprintln!("Usage: lore-transcribe AUDIO.wav MODEL.bin [auto|no|en]");
        std::process::exit(2);
    }
    let language = match args.get(2).map(String::as_str).unwrap_or("auto") {
        "auto" => TranscriptionLanguage::Auto,
        "no" => TranscriptionLanguage::No,
        "en" => TranscriptionLanguage::En,
        _ => {
            eprintln!("Language must be auto, no, or en");
            std::process::exit(2);
        }
    };
    match transcribe(
        Path::new(&args[0]),
        Path::new(&args[1]),
        language,
        |detail| eprintln!("{detail}"),
    )
    .await
    {
        Ok(text) => println!("{text}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
