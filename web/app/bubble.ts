// A browser tab can't draw over other apps, so the camera bubble is a Picture-in-Picture window:
// it floats above everything and gets captured by the screen share, same idea as the desktop bubble.

interface DocumentPictureInPicture {
  requestWindow(options: { width: number; height: number }): Promise<Window>;
}

export async function openBubble(stream: MediaStream, onClose: () => void): Promise<() => void> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.srcObject = stream;

  const docPip = (window as Window & { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture;
  if (docPip) { // Chrome / Edge
    const win = await docPip.requestWindow({ width: 260, height: 260 });
    Object.assign(win.document.body.style, { margin: '0', background: '#111', overflow: 'hidden' });
    Object.assign(video.style, { width: '100vw', height: '100vh', objectFit: 'cover', transform: 'scaleX(-1)' });
    win.document.body.append(video);
    win.addEventListener('pagehide', onClose, { once: true });
    return () => win.close();
  }

  if (document.pictureInPictureEnabled) { // Safari
    video.className = 'pip-source';
    document.body.append(video);
    await video.play();
    await video.requestPictureInPicture();
    video.addEventListener('leavepictureinpicture', () => { video.remove(); onClose(); }, { once: true });
    return () => { if (document.pictureInPictureElement) void document.exitPictureInPicture(); };
  }

  throw new Error('This browser cannot float a camera bubble. Use Chrome, Edge or Safari, or record "Screen" only.');
}
