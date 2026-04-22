import { SendHorizontal } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";

export function ChatView(): React.JSX.Element {
  const [message, setMessage] = useState("");
  const [disabled, setDisabled] = useState(window.comeji === undefined);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (window.comeji === undefined) {
      setMessage("preload missing");
      return;
    }

    inputRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        window.comeji.closeChat();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmedMessage = message.trim();

    if (trimmedMessage.length === 0 || window.comeji === undefined) {
      inputRef.current?.focus();
      return;
    }

    setDisabled(true);
    void window.comeji.submitChat(trimmedMessage);
  }

  return (
    <main className="chat-panel">
      <form className="chat-form" onSubmit={submit}>
        <div className="chat-header">
          <label className="chat-label" htmlFor="message">
            말 걸기
          </label>
          <span className="chat-escape">Esc</span>
        </div>
        <textarea
          ref={inputRef}
          id="message"
          className="chat-input"
          rows={3}
          maxLength={240}
          value={message}
          disabled={disabled}
          onChange={(event) => setMessage(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="chat-actions">
          <span className="chat-hint">Enter로 보내고, Shift+Enter로 줄바꿈</span>
          <button className="chat-button" type="submit" disabled={disabled} aria-label="보내기">
            <SendHorizontal className="size-4" />
            보내기
          </button>
        </div>
      </form>
    </main>
  );
}
