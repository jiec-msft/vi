const canvas = document.getElementById('canvas');
const context = canvas.getContext('2d');
const recording = new MediaRecorder(canvas.captureStream(5), { mimeType: 'video/webm;codecs=vp8' });
const pending = [];
recording.ondataavailable = ({ data }) => {
  if (data.size) pending.push(data.arrayBuffer().then((bytes) => window.recorder.chunk(new Uint8Array(bytes))));
};
recording.onstop = async () => { await Promise.all(pending); window.recorder.done(); };
window.recorder.frame(async (png) => {
  const image = await createImageBitmap(new Blob([png], { type: 'image/png' }));
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close();
});
window.recorder.stop(() => recording.stop());
recording.start(200);
