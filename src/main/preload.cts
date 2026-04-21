import { contextBridge, ipcRenderer } from "electron";
import type { CharacterState, PointerSample, SpeechMessage } from "../shared/character-state.js";
import type { ShimejiApi } from "../shared/shimeji-api.js";

const api: ShimejiApi = {
  onCharacterState(listener) {
    const channel = "character-state";
    const wrapped = (_event: Electron.IpcRendererEvent, state: CharacterState): void => {
      listener(state);
    };

    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.off(channel, wrapped);
  },
  onSpeech(listener) {
    const channel = "speech";
    const wrapped = (_event: Electron.IpcRendererEvent, message: SpeechMessage): void => {
      listener(message);
    };

    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.off(channel, wrapped);
  },
  beginPointerCapture() {
    ipcRenderer.send("pointer-capture-begin");
  },
  endPointerCapture() {
    ipcRenderer.send("pointer-capture-end");
  },
  beginDrag(sample: PointerSample) {
    ipcRenderer.send("drag-begin", sample);
  },
  drag(sample: PointerSample) {
    ipcRenderer.send("drag-move", sample);
  },
  endDrag(sample: PointerSample) {
    ipcRenderer.send("drag-end", sample);
  },
  openChat() {
    ipcRenderer.send("chat-open");
  },
  closeChat() {
    ipcRenderer.send("chat-close");
  },
  async submitChat(message: string) {
    await ipcRenderer.invoke("chat-submit", message);
  },
  openSettings() {
    ipcRenderer.send("settings-open");
  },
  async getCodexLoginStatus() {
    return await ipcRenderer.invoke("codex-login-status");
  },
  async listCodexSessions() {
    return await ipcRenderer.invoke("codex-sessions-list");
  },
  async getCodexSessionDetail(id: string) {
    return await ipcRenderer.invoke("codex-session-detail", id);
  },
  async selectCodexSession(id: string) {
    await ipcRenderer.invoke("codex-session-select", id);
  },
  async clearCodexSession() {
    await ipcRenderer.invoke("codex-session-clear");
  },
  async deleteCodexSession(id: string) {
    await ipcRenderer.invoke("codex-session-delete", id);
  },
  async getPromptSettings() {
    return await ipcRenderer.invoke("prompt-settings-get");
  },
  async savePromptSettings(settings) {
    await ipcRenderer.invoke("prompt-settings-save", settings);
  },
  async getAppearanceSettings() {
    return await ipcRenderer.invoke("appearance-settings-get");
  },
  async saveAppearanceSettings(settings) {
    return await ipcRenderer.invoke("appearance-settings-save", settings);
  },
  async uploadSpriteSheet(upload) {
    return await ipcRenderer.invoke("sprite-sheet-upload", upload);
  },
  async selectSpriteSheet(id) {
    return await ipcRenderer.invoke("sprite-sheet-select", id);
  },
  async updateSpriteSheet(settings) {
    return await ipcRenderer.invoke("sprite-sheet-update", settings);
  },
  async deleteSpriteSheet(id) {
    return await ipcRenderer.invoke("sprite-sheet-delete", id);
  },
};

contextBridge.exposeInMainWorld("shimeji", api);
