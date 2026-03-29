/**
 * ExportButton — Dropdown button to export the current conversation as JSON or Markdown.
 *
 * INTEGRATION NOTE: This component should be placed in the ChatPage header section,
 * next to the ModelSelector. Example usage:
 *
 *   import ExportButton from "./ExportButton";
 *   ...
 *   <ExportButton conversationId={conversationIdRef.current} />
 *
 * It will only render when a conversationId is provided (i.e., not on "New Chat").
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { useAuth } from "../auth/useAuth";
import { createAgent } from "../api/agent";
import {
  createGatewayActor,
  type CandidExportFormat,
} from "../api/gateway.did";

interface ExportButtonProps {
  /** The current conversation ID. If null/undefined, the button is hidden. */
  conversationId: string | null | undefined;
}

/** Trigger a browser file download from a text string. */
function downloadText(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ExportButton({ conversationId }: ExportButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { authClient } = useAuth();

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!isOpen) return;
    function handleClick(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [isOpen]);

  const handleExport = useCallback(
    async (format: "JSON" | "Markdown") => {
      if (!conversationId || isExporting) return;
      setIsExporting(true);
      setIsOpen(false);

      try {
        const agent = await createAgent(authClient ?? undefined);
        const gateway = createGatewayActor(agent);
        const candidFormat: CandidExportFormat =
          format === "JSON" ? { JSON: null } : { Markdown: null };
        const result = await gateway.exportConversation(
          conversationId,
          candidFormat
        );

        if ("ok" in result) {
          const ext = format === "JSON" ? "json" : "md";
          const filename = `conversation-${conversationId}.${ext}`;
          downloadText(result.ok as string, filename);
        } else {
          const errKey = Object.keys(
            (result as { err: Record<string, unknown> }).err
          )[0];
          console.error("Export failed:", errKey);
        }
      } catch (error) {
        console.error("Export error:", error);
      } finally {
        setIsExporting(false);
      }
    },
    [conversationId, authClient, isExporting]
  );

  if (!conversationId) return null;

  return (
    <div ref={dropdownRef} style={{ position: "relative" }}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        disabled={isExporting}
        style={{
          background: "none",
          border: "1px solid var(--border)",
          color: "var(--text-secondary)",
          padding: "0.35rem 0.6rem",
          borderRadius: "6px",
          fontSize: "0.8rem",
          cursor: isExporting ? "wait" : "pointer",
          display: "flex",
          alignItems: "center",
          gap: "0.3rem",
          transition: "all 0.15s",
          opacity: isExporting ? 0.6 : 1,
        }}
        title="Export conversation"
      >
        {isExporting ? "Exporting..." : "Export"}
      </button>

      {isOpen && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            marginTop: "4px",
            backgroundColor: "var(--bg-secondary)",
            border: "1px solid var(--border)",
            borderRadius: "6px",
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            zIndex: 100,
            minWidth: "140px",
            overflow: "hidden",
          }}
        >
          <button
            onClick={() => handleExport("JSON")}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              background: "none",
              border: "none",
              color: "var(--text-primary)",
              padding: "0.5rem 0.75rem",
              fontSize: "0.82rem",
              cursor: "pointer",
              borderBottom: "1px solid var(--border)",
            }}
            onMouseEnter={(e) =>
              ((e.currentTarget as HTMLButtonElement).style.backgroundColor =
                "var(--bg-tertiary)")
            }
            onMouseLeave={(e) =>
              ((e.currentTarget as HTMLButtonElement).style.backgroundColor =
                "transparent")
            }
          >
            Export JSON
          </button>
          <button
            onClick={() => handleExport("Markdown")}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              background: "none",
              border: "none",
              color: "var(--text-primary)",
              padding: "0.5rem 0.75rem",
              fontSize: "0.82rem",
              cursor: "pointer",
            }}
            onMouseEnter={(e) =>
              ((e.currentTarget as HTMLButtonElement).style.backgroundColor =
                "var(--bg-tertiary)")
            }
            onMouseLeave={(e) =>
              ((e.currentTarget as HTMLButtonElement).style.backgroundColor =
                "transparent")
            }
          >
            Export Markdown
          </button>
        </div>
      )}
    </div>
  );
}
