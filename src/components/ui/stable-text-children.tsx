// @no-export
import * as React from 'react';

// Keep text separate from changing icon siblings. Group adjacent text into one
// inline box so flex gap does not introduce spacing between pieces of a label.
export function stableTextChildren(children: React.ReactNode): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  let text = '';
  let hasText = false;
  const flush = () => {
    if (!hasText) return;
    result.push(<span key={`text-${result.length}`}>{text}</span>);
    text = '';
    hasText = false;
  };
  for (const child of React.Children.toArray(children)) {
    if (typeof child === 'string' || typeof child === 'number') {
      text += child;
      hasText = true;
    } else {
      flush();
      result.push(child);
    }
  }
  flush();
  return result;
}
