'use client';

import { useState } from 'react';

export function CopyLink({ url }: { url: string }) {
  const [isCopied, setIsCopied] = useState(false);
  const handleCopy = () => navigator.clipboard.writeText(url).then(() => {
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 1500);
  }).catch(() => {});
  return <button type="button" className="link" onClick={handleCopy}>{isCopied ? 'Copied ✓' : 'Copy link'}</button>;
}
