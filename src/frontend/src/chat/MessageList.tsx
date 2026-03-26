import { useEffect, useRef } from "react";
import type { ChatMessage } from "./ChatPage";

interface MessageListProps {
  messages: ChatMessage[];
  isLoading: boolean;
}

export default function MessageList({ messages, isLoading }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  if (messages.length === 0 && !isLoading) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          color: "var(--text-muted)",
        }}
      >
        <span style={{ fontSize: "3rem" }}>🦀</span>
        <p style={{ fontSize: "1.1rem" }}>
          Start a conversation with an on-chain AI
        </p>
        <p style={{ fontSize: "0.85rem" }}>
          Choose a model above and type your message below
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "1.5rem",
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
      }}
    >
      {messages.map((msg, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
          }}
        >
          <div
            style={{
              maxWidth: "70%",
              padding: "0.85rem 1.1rem",
              borderRadius: msg.role === "user" ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
              backgroundColor:
                msg.role === "user" ? "var(--accent)" : "var(--bg-tertiary)",
              color: msg.role === "user" ? "white" : "var(--text-primary)",
              lineHeight: 1.5,
              fontSize: "0.95rem",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {msg.content}
          </div>
        </div>
      ))}

      {isLoading && (
        <div style={{ display: "flex", justifyContent: "flex-start" }}>
          <div
            style={{
              padding: "0.85rem 1.1rem",
              borderRadius: "16px 16px 16px 4px",
              backgroundColor: "var(--bg-tertiary)",
              color: "var(--text-muted)",
              fontSize: "0.95rem",
            }}
          >
            Thinking...
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
