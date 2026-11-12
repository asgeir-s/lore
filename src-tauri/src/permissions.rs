use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionStatus {
    Granted,
    Denied,
    Restricted,
    Unknown,
    Unavailable,
    #[cfg(not(target_os = "macos"))]
    NotRequired,
}

#[derive(Clone, Debug, Serialize)]
pub struct RecordingPermissions {
    pub supported: bool,
    pub microphone: PermissionStatus,
    pub system_audio: PermissionStatus,
}

impl RecordingPermissions {
    pub fn recording_error(&self) -> Option<String> {
        if !self.supported {
            return None;
        }
        let missing = [
            ("microphone", self.microphone),
            ("system audio", self.system_audio),
        ]
        .into_iter()
        .filter(|(_, status)| {
            matches!(
                status,
                PermissionStatus::Denied | PermissionStatus::Restricted | PermissionStatus::Unknown
            )
        })
        .map(|(name, _)| name)
        .collect::<Vec<_>>();
        // Unavailable means that the OS check cannot establish permission, not
        // that access was denied. The notice stays visible; normal capture may
        // still request access on systems without the preflight API.
        (!missing.is_empty()).then(|| format!(
            "Recording needs {} access. Use the recording access notice to allow it before starting.",
            missing.join(" and ")
        ))
    }
}

#[cfg(target_os = "macos")]
extern "C" {
    fn lore_microphone_permission() -> i32;
    fn lore_request_microphone_permission();
    fn lore_system_audio_permission() -> i32;
    fn lore_request_system_audio_permission() -> bool;
}

#[cfg(target_os = "macos")]
fn native_status(value: i32) -> PermissionStatus {
    match value {
        0 => PermissionStatus::Granted,
        1 => PermissionStatus::Denied,
        2 => PermissionStatus::Restricted,
        3 => PermissionStatus::Unknown,
        _ => PermissionStatus::Unavailable,
    }
}

#[tauri::command]
pub fn check_recording_permissions() -> RecordingPermissions {
    #[cfg(target_os = "macos")]
    unsafe {
        RecordingPermissions {
            supported: true,
            microphone: native_status(lore_microphone_permission()),
            system_audio: native_status(lore_system_audio_permission()),
        }
    }
    #[cfg(not(target_os = "macos"))]
    RecordingPermissions {
        supported: false,
        microphone: PermissionStatus::NotRequired,
        system_audio: PermissionStatus::NotRequired,
    }
}

#[tauri::command]
pub fn request_recording_permission(kind: String) -> Result<(), String> {
    match kind.as_str() {
        "microphone" => {
            #[cfg(target_os = "macos")]
            unsafe {
                lore_request_microphone_permission();
            }
            Ok(())
        }
        "system_audio" => {
            #[cfg(target_os = "macos")]
            if !unsafe { lore_request_system_audio_permission() } {
                return Err(
                    "Open System Settings to allow system audio access, then check again.".into(),
                );
            }
            Ok(())
        }
        _ => Err("Unknown recording permission".into()),
    }
}

#[tauri::command]
pub async fn open_recording_privacy_settings(kind: String) -> Result<(), String> {
    let pane = match kind.as_str() {
        "microphone" => "Privacy_Microphone",
        "system_audio" => "Privacy_AudioCapture",
        _ => return Err("Unknown recording permission".into()),
    };
    #[cfg(target_os = "macos")]
    {
        let status = crate::qmd::cmd("/usr/bin/open")
            .arg(format!(
                "x-apple.systempreferences:com.apple.preference.security?{pane}"
            ))
            .status()
            .await
            .map_err(|e| format!("Open privacy settings: {e}"))?;
        if !status.success() {
            return Err("Could not open System Settings".into());
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = pane;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_missing_permissions_block_recording_but_unavailable_checks_are_not_denials() {
        let status = |microphone, system_audio| RecordingPermissions {
            supported: true,
            microphone,
            system_audio,
        };
        assert!(status(PermissionStatus::Granted, PermissionStatus::Granted)
            .recording_error()
            .is_none());
        for value in [
            PermissionStatus::Unknown,
            PermissionStatus::Denied,
            PermissionStatus::Restricted,
        ] {
            assert!(status(value, PermissionStatus::Granted)
                .recording_error()
                .unwrap()
                .contains("microphone"));
            assert!(status(PermissionStatus::Granted, value)
                .recording_error()
                .unwrap()
                .contains("system audio"));
        }
        assert!(
            status(PermissionStatus::Granted, PermissionStatus::Unavailable)
                .recording_error()
                .is_none()
        );
        assert_eq!(
            serde_json::to_value(PermissionStatus::Unavailable).unwrap(),
            "unavailable"
        );
    }
}
