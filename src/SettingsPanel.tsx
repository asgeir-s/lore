import { useState, useEffect, useCallback } from "react";
import { listInputDevices } from "./api";
import type {
  ToolStatus,
  InputDeviceInfo,
  ModelSettings,
  OllamaModelInfo,
  WhisperModelInfo,
  InstallToolKey,
} from "./api";

export interface PullProgress {
  model: string;
  status: string;
  percent: number | null;
}

interface SettingsPanelProps {
  toolStatus: ToolStatus;
  notesDirPath: string | null;
  gitRemoteUrl: string | null;
  onSaveNotesDir: (path: string) => Promise<void>;
  onSaveGitRemote: (url: string) => Promise<void>;
  recordingDevice: string | null;
  onDeviceChange: (device: string | null) => void;
  onRefreshTools: () => void;
  onInstallTool: (tool: InstallToolKey) => Promise<void>;
  onClose: () => void;
  modelSettings: ModelSettings;
  ollamaModels: OllamaModelInfo[];
  whisperModels: WhisperModelInfo[];
  onModelSettingsChange: (settings: ModelSettings) => void;
  onPullModel: (name: string) => Promise<void>;
  pullProgress: PullProgress | null;
}

const TOOLS = [
  {
    key: "git" as InstallToolKey,
    label: "git",
    description: "Version control & sync",
  },
  {
    key: "ffmpeg" as InstallToolKey,
    label: "ffmpeg",
    description: "Audio processing",
  },
  {
    key: "whisper" as InstallToolKey,
    label: "whisper-cli",
    description: "Speech transcription",
  },
  {
    key: "ollama" as InstallToolKey,
    label: "ollama",
    description: "AI tagging & summaries",
  },
  {
    key: "qmd" as InstallToolKey,
    label: "qmd",
    description: "Related notes search",
  },
];
type ToolKey = InstallToolKey;

function getInstallCommand(tool: ToolKey): string {
  const platform =
    typeof navigator !== "undefined"
      ? (navigator.platform || navigator.userAgent || "").toLowerCase()
      : "";
  const isMac = platform.includes("mac");
  const isLinux = platform.includes("linux");

  if (isMac) {
    if (tool === "git") return "xcode-select --install";
    return "Opens Terminal and runs setup-macos.sh";
  }

  if (isLinux) {
    if (tool === "git") return "sudo apt-get install -y git";
    return "Opens Terminal and runs setup-ubuntu.sh";
  }

  if (tool === "git") return "Install git via your OS package manager";
  return "Opens Terminal and runs the platform setup script";
}

function formatSize(bytes: number | null): string {
  if (bytes === null || bytes === 0) return "";
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${Math.round(bytes / 1_000)} KB`;
}

export function SettingsPanel({
  toolStatus,
  notesDirPath,
  gitRemoteUrl,
  onSaveNotesDir,
  onSaveGitRemote,
  recordingDevice,
  onDeviceChange,
  onRefreshTools,
  onInstallTool,
  onClose,
  modelSettings,
  ollamaModels,
  whisperModels,
  onModelSettingsChange,
  onPullModel,
  pullProgress,
}: SettingsPanelProps) {
  const [devices, setDevices] = useState<InputDeviceInfo[]>([]);
  const [pullingModel, setPullingModel] = useState<string | null>(null);
  const [installingTool, setInstallingTool] = useState<ToolKey | null>(null);
  const [notesPathInput, setNotesPathInput] = useState(notesDirPath ?? "");
  const [gitRemoteInput, setGitRemoteInput] = useState(gitRemoteUrl ?? "");
  const [savingNotesPath, setSavingNotesPath] = useState(false);
  const [savingGitRemote, setSavingGitRemote] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);

  useEffect(() => {
    listInputDevices()
      .then(setDevices)
      .catch(() => setDevices([]));
  }, []);

  useEffect(() => {
    setNotesPathInput(notesDirPath ?? "");
  }, [notesDirPath]);

  useEffect(() => {
    setGitRemoteInput(gitRemoteUrl ?? "");
  }, [gitRemoteUrl]);

  // Escape and click-outside to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  const handleSelectChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value;
      onDeviceChange(value === "" ? null : value);
    },
    [onDeviceChange],
  );

  const handleOllamaModelChange = useCallback(
    (field: "keyword_model" | "summary_model") =>
      (e: React.ChangeEvent<HTMLSelectElement>) => {
        const value = e.target.value || null;
        onModelSettingsChange({ ...modelSettings, [field]: value });
      },
    [modelSettings, onModelSettingsChange],
  );

  const handleWhisperModelChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value || null;
      onModelSettingsChange({ ...modelSettings, whisper_model: value });
    },
    [modelSettings, onModelSettingsChange],
  );

  const handlePullModel = useCallback(
    async (name: string) => {
      setPullingModel(name);
      try {
        await onPullModel(name);
      } finally {
        setPullingModel(null);
      }
    },
    [onPullModel],
  );

  const handleInstallTool = useCallback(
    async (tool: ToolKey) => {
      setInstallingTool(tool);
      try {
        await onInstallTool(tool);
      } finally {
        setInstallingTool(null);
      }
    },
    [onInstallTool],
  );

  const handleSaveNotesPath = useCallback(async () => {
    const nextPath = notesPathInput.trim();
    if (!nextPath) return;
    setStorageError(null);
    setSavingNotesPath(true);
    try {
      await onSaveNotesDir(nextPath);
    } catch (e) {
      setStorageError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingNotesPath(false);
    }
  }, [notesPathInput, onSaveNotesDir]);

  const handleSaveGitRemote = useCallback(async () => {
    const nextRemote = gitRemoteInput.trim();
    if (!nextRemote) return;
    setStorageError(null);
    setSavingGitRemote(true);
    try {
      await onSaveGitRemote(nextRemote);
    } catch (e) {
      setStorageError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingGitRemote(false);
    }
  }, [gitRemoteInput, onSaveGitRemote]);

  const installedOllama = ollamaModels.filter((m) => m.installed);
  const uninstalledOllama = ollamaModels.filter((m) => !m.installed);

  return (
    <div className="settings-overlay" onMouseDown={onClose}>
      <div className="settings-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-section">
          <div className="settings-section-title">Storage & Sync</div>

          <div className="settings-info-block">
            <div className="settings-info-label">Notes folder on disk</div>
            <div className="settings-inline-input-row">
              <input
                className="settings-text-input"
                value={notesPathInput}
                onChange={(e) => setNotesPathInput(e.target.value)}
                placeholder="/path/to/notes"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleSaveNotesPath();
                  }
                }}
              />
              <button
                className="settings-inline-save-btn"
                disabled={savingNotesPath || notesPathInput.trim().length === 0}
                onClick={() => void handleSaveNotesPath()}
              >
                {savingNotesPath ? "Saving..." : "Save"}
              </button>
            </div>
          </div>

          <div className="settings-info-block">
            <div className="settings-info-label">Git remote</div>
            <div className="settings-inline-input-row">
              <input
                className="settings-text-input"
                value={gitRemoteInput}
                onChange={(e) => setGitRemoteInput(e.target.value)}
                placeholder="git@github.com:user/repo.git"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleSaveGitRemote();
                  }
                }}
              />
              <button
                className="settings-inline-save-btn"
                disabled={savingGitRemote || gitRemoteInput.trim().length === 0}
                onClick={() => void handleSaveGitRemote()}
              >
                {savingGitRemote ? "Saving..." : "Save"}
              </button>
            </div>
          </div>

          {storageError && (
            <div className="settings-storage-error">{storageError}</div>
          )}
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Recording Device</div>
          <select
            className="settings-device-select"
            value={recordingDevice ?? ""}
            onChange={handleSelectChange}
          >
            <option value="">Auto-detect</option>
            {devices.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
                {d.is_default ? " (default)" : ""}
              </option>
            ))}
          </select>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Models</div>

          <label className="settings-model-label">
            Keywords model (ollama)
          </label>
          <select
            className="settings-device-select"
            value={modelSettings.keyword_model ?? ""}
            onChange={handleOllamaModelChange("keyword_model")}
          >
            <option value="">Auto-detect</option>
            {installedOllama.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
                {m.size_bytes ? ` (${formatSize(m.size_bytes)})` : ""}
              </option>
            ))}
          </select>

          <label className="settings-model-label">Summary model (ollama)</label>
          <select
            className="settings-device-select"
            value={modelSettings.summary_model ?? ""}
            onChange={handleOllamaModelChange("summary_model")}
          >
            <option value="">Auto-detect</option>
            {installedOllama.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
                {m.size_bytes ? ` (${formatSize(m.size_bytes)})` : ""}
              </option>
            ))}
          </select>

          <label className="settings-model-label">
            Transcription model (whisper)
          </label>
          <select
            className="settings-device-select"
            value={modelSettings.whisper_model ?? ""}
            onChange={handleWhisperModelChange}
          >
            <option value="">Auto-detect</option>
            {whisperModels.map((m) => (
              <option key={m.path} value={m.name}>
                {m.name} ({formatSize(m.size_bytes)})
              </option>
            ))}
          </select>

          {uninstalledOllama.length > 0 && (
            <div className="settings-model-recommended">
              <div className="settings-model-recommended-title">
                Recommended ollama models
              </div>
              {uninstalledOllama.map((m) => (
                <div key={m.name} className="settings-model-row">
                  <span className="settings-model-name">{m.name}</span>
                  <span className="settings-model-size">
                    {m.parameter_size ?? ""}
                    {m.size_bytes ? ` · ${formatSize(m.size_bytes)}` : ""}
                  </span>
                  {pullingModel === m.name && pullProgress?.model === m.name ? (
                    <div className="settings-model-progress">
                      <div className="settings-model-progress-text">
                        {pullProgress.percent !== null
                          ? `Downloading... ${pullProgress.percent}%`
                          : pullProgress.status}
                      </div>
                      {pullProgress.percent !== null && (
                        <div className="settings-model-progress-bar">
                          <div
                            className="settings-model-progress-fill"
                            style={{ width: `${pullProgress.percent}%` }}
                          />
                        </div>
                      )}
                    </div>
                  ) : (
                    <button
                      className="settings-model-install-btn"
                      disabled={pullingModel !== null}
                      onClick={() => handlePullModel(m.name)}
                    >
                      {pullingModel === m.name ? "Installing..." : "Install"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {TOOLS.some((t) => !toolStatus[t.key]) && (
          <div className="settings-section">
            <div className="settings-section-title">
              Missing Tools
              <button className="settings-refresh-btn" onClick={onRefreshTools}>
                Refresh
              </button>
            </div>
            {TOOLS.filter((t) => !toolStatus[t.key]).map((tool) => (
              <div key={tool.key} className="settings-install-section">
                <div className="settings-tool-row">
                  <div className="settings-tool-info">
                    <span className="settings-tool-name">{tool.label}</span>
                    <span className="settings-tool-desc">
                      {tool.description}
                    </span>
                  </div>
                  <button
                    className="settings-model-install-btn"
                    disabled={installingTool !== null}
                    onClick={() => handleInstallTool(tool.key)}
                  >
                    {installingTool === tool.key ? "Opening..." : "Install"}
                  </button>
                </div>
                <code className="settings-install-cmd">
                  {getInstallCommand(tool.key)}
                </code>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
