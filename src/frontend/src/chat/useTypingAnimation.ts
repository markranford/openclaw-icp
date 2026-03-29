import { useState, useEffect, useRef, useCallback } from "react";

/**
 * Hook that animates text appearing character-by-character.
 * Returns the currently visible portion of the text.
 *
 * @param fullText - The complete text to animate
 * @param isActive - Whether animation should run (false = show full text immediately)
 * @param charsPerFrame - Characters to reveal per animation frame (default 3)
 * @returns { displayedText, isAnimating, skipToEnd }
 */
export function useTypingAnimation(
  fullText: string,
  isActive: boolean,
  charsPerFrame: number = 3
): {
  displayedText: string;
  isAnimating: boolean;
  skipToEnd: () => void;
} {
  const [charIndex, setCharIndex] = useState(0);
  const [skipped, setSkipped] = useState(false);
  const rafRef = useRef<number | null>(null);
  const fullTextRef = useRef(fullText);

  // When fullText changes and animation is active, restart from 0
  useEffect(() => {
    if (isActive && fullText !== fullTextRef.current) {
      fullTextRef.current = fullText;
      setCharIndex(0);
      setSkipped(false);
    } else {
      fullTextRef.current = fullText;
    }
  }, [fullText, isActive]);

  // If not active, always show full text
  useEffect(() => {
    if (!isActive) {
      setCharIndex(fullText.length);
      setSkipped(false);
    }
  }, [isActive, fullText]);

  // Animation loop using requestAnimationFrame
  useEffect(() => {
    if (!isActive || skipped || charIndex >= fullText.length) {
      return;
    }

    const animate = () => {
      setCharIndex((prev) => {
        if (prev >= fullText.length) return prev;

        let next = prev + charsPerFrame;

        // If we're inside a code fence block, skip to the end of it
        const upcoming = fullText.slice(prev);
        const codeFenceStart = upcoming.indexOf("```");
        if (codeFenceStart !== -1 && codeFenceStart < charsPerFrame) {
          // We're about to enter a code fence — find the closing fence
          const afterOpen = fullText.indexOf("```", prev + codeFenceStart + 3);
          if (afterOpen !== -1) {
            // Jump past the closing ``` and its line
            next = afterOpen + 3;
            const newlineAfter = fullText.indexOf("\n", next);
            if (newlineAfter !== -1 && newlineAfter - next < 2) {
              next = newlineAfter + 1;
            }
          } else {
            // No closing fence found yet, jump to end of current text
            next = fullText.length;
          }
        }

        return Math.min(next, fullText.length);
      });

      rafRef.current = requestAnimationFrame(animate);
    };

    rafRef.current = requestAnimationFrame(animate);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isActive, skipped, charIndex, fullText, charsPerFrame]);

  const skipToEnd = useCallback(() => {
    setSkipped(true);
    setCharIndex(fullText.length);
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, [fullText]);

  const isAnimating = isActive && !skipped && charIndex < fullText.length;
  const displayedText = isActive && !skipped ? fullText.slice(0, charIndex) : fullText;

  return { displayedText, isAnimating, skipToEnd };
}
