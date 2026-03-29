/**
 * @file Scrollable chat message list with auto-scroll, empty-state display,
 * and typing animation for the latest assistant response.
 *
 * Renders the conversation as a vertical list of message bubbles:
 * - **User messages** are right-aligned with the accent color background.
 * - **Assistant messages** are left-aligned with the tertiary background color.
 *
 * The component automatically scrolls to the bottom whenever new messages
 * arrive or the loading state changes, using a hidden sentinel `<div>` at
 * the end of the list and `scrollIntoView({ behavior: "smooth" })`.
 *
 * When no messages exist and the model is not loading, an empty-state prompt
 * is shown inviting the user to start a conversation.
 *
 * The last assistant message can optionally be animated with a character-by-
 * character typing effect via the `isAnimatingResponse` prop.
 *
 * @module chat/MessageList
 */

import { useEffect, useRef } from "react";
import type { ChatMessage } from "./ChatPage";
import { useTypingAnimation } from "./useTypingAnimation";

/**
 * Props for the {@link MessageList} component.
 *
 * @property messages - The ordered list of chat messages to render.
 * @property isLoading - Whether a response is currently being fetched.
 *   When `true`, a "Thinking..." indicator is shown at the bottom.
 * @property isAnimatingResponse - Whether the latest assistant response
 *   should be revealed with a typing animation.
 * @property onAnimationComplete - Callback fired when the typing animation
 *   finishes (either naturally or via skip).
 */
interface MessageListProps {
  messages: ChatMessage[];
  isLoading: boolean;
  isAnimatingResponse?: boolean;
  onAnimationComplete?: () => void;
}

/** CSS keyframes for the blinking cursor, injected once. */
const cursorStyleId = "typing-cursor-keyframes";
function ensureCursorStyles() {
  if (document.getElementById(cursorStyleId)) return;
  const style = document.createElement("style");
  style.id = cursorStyleId;
  style.textContent = `
    @keyframes blink-cursor {
      0%, 100% { opacity: 1; }
      50% { opacity: 0; }
    }
  `;
  document.head.appendChild(style);
}

/**
 * Sub-component that renders the last assistant message with typing animation.
 */
function AnimatedMessage({
  content,
  isActive,
  onComplete,
}: {
  content: string;
  isActive: boolean;
  onComplete?: () => void;
}) {
  const { displayedText, isAnimating, skipToEnd } = useTypingAnimation(
    content,
    isActive,
    3
  );
  const prevIsAnimating = useRef(isAnimating);

  // Fire onComplete when animation transitions from true -> false
  useEffect(() => {
    if (prevIsAnimating.current && !isAnimating && onComplete) {
      onComplete();
    }
    prevIsAnimating.current = isAnimating;
  }, [isAnimating, onComplete]);

  useEffect(() => {
    ensureCursorStyles();
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "flex-start",
        }}
      >
        <div
          onClick={isAnimating ? skipToEnd : undefined}
          style={{
            maxWidth: "70%",
            padding: "0.85rem 1.1rem",
            borderRadius: "16px 16px 16px 4px",
            backgroundColor: "var(--bg-tertiary)",
            color: "var(--text-primary)",
            lineHeight: 1.5,
            fontSize: "0.95rem",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            cursor: isAnimating ? "pointer" : "default",
          }}
        >
          {displayedText}
          {isAnimating && (
            <span
              style={{
                animation: "blink-cursor 0.7s step-end infinite",
                marginLeft: "1px",
                fontWeight: "bold",
              }}
            >
              {"\u2588"}
            </span>
          )}
        </div>
      </div>
      {isAnimating && (
        <button
          onClick={skipToEnd}
          style={{
            marginTop: "0.35rem",
            marginLeft: "0.25rem",
            background: "none",
            border: "1px solid var(--border)",
            borderRadius: "6px",
            color: "var(--text-muted)",
            fontSize: "0.75rem",
            padding: "0.2rem 0.5rem",
            cursor: "pointer",
          }}
        >
          {"Skip \u25B8"}
        </button>
      )}
    </div>
  );
}

/**
 * Displays the chat conversation as a scrollable list of message bubbles.
 *
 * Message styling:
 * - User bubbles: right-aligned, accent background, white text, rounded with
 *   a small notch on the bottom-right.
 * - Assistant bubbles: left-aligned, tertiary background, primary text color,
 *   rounded with a small notch on the bottom-left.
 *
 * A loading indicator ("Thinking...") appears as a left-aligned bubble while
 * the canister is processing.
 */
export default function MessageList({
  messages,
  isLoading,
  isAnimatingResponse = false,
  onAnimationComplete,
}: MessageListProps) {
  /** Invisible element at the bottom used as the scroll-to target. */
  const bottomRef = useRef<HTMLDivElement>(null);

  // Find the index of the last assistant message (candidate for animation)
  const lastAssistantIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return i;
    }
    return -1;
  })();

  // Auto-scroll to bottom whenever messages change or loading state toggles
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  // Also auto-scroll during animation (the AnimatedMessage re-renders as text grows)
  // We handle this by scrolling on any render when animating
  useEffect(() => {
    if (isAnimatingResponse) {
      const interval = setInterval(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      }, 100);
      return () => clearInterval(interval);
    }
  }, [isAnimatingResponse]);

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
      {messages.map((msg, i) => {
        // If this is the last assistant message and animation is active, use AnimatedMessage
        if (i === lastAssistantIndex && isAnimatingResponse && msg.role === "assistant") {
          return (
            <AnimatedMessage
              key={i}
              content={msg.content}
              isActive={isAnimatingResponse}
              onComplete={onAnimationComplete}
            />
          );
        }

        return (
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
        );
      })}

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
