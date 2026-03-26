import { useState, useRef, useCallback, KeyboardEvent } from "react";

interface InputBarProps {
  onSend: (text: string) => void;
  isLoading: boolean;
}

export default function InputBar({ onSend, isLoading }: InputBarProps) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    if (text.trim() && !isLoading) {
      onSend(text.trim());
      setText("");
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    }
  }, [text, isLoading, onSend]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleInput = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height =
        Math.min(textareaRef.current.scrollHeight, 200) + "px";
    }
  }, []);

  return (
    <div
      style={{
        padding: "1rem 1.5rem",
        borderTop: "1px solid var(--border)",
        backgroundColor: "var(--bg-secondary)",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: "0.75rem",
          alignItems: "flex-end",
          maxWidth: "800px",
          margin: "0 auto",
        }}
      >
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          placeholder="Type a message... (Enter to send, Shift+Enter for new line)"
          disabled={isLoading}
          rows={1}
          style={{
            flex: 1,
            resize: "none",
            border: "1px solid var(--border)",
            borderRadius: "12px",
            padding: "0.75rem 1rem",
            backgroundColor: "var(--bg-primary)",
            color: "var(--text-primary)",
            fontSize: "0.95rem",
            lineHeight: 1.5,
            outline: "none",
            minHeight: "44px",
            maxHeight: "200px",
            transition: "border-color 0.15s",
          }}
        />
        <button
          onClick={handleSend}
          disabled={!text.trim() || isLoading}
          style={{
            padding: "0.7rem 1.25rem",
            backgroundColor:
              text.trim() && !isLoading ? "var(--accent)" : "var(--bg-tertiary)",
            color: text.trim() && !isLoading ? "white" : "var(--text-muted)",
            border: "none",
            borderRadius: "12px",
            fontWeight: 600,
            fontSize: "0.9rem",
            transition: "all 0.15s",
            minHeight: "44px",
          }}
        >
          {isLoading ? "..." : "Send"}
        </button>
      </div>
      <p
        style={{
          textAlign: "center",
          color: "var(--text-muted)",
          fontSize: "0.7rem",
          marginTop: "0.5rem",
        }}
      >
        OpenClaw ICP v0.1.0 — Powered by Internet Computer
      </p>
    </div>
  );
}
