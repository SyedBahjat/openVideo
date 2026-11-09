const device = new URLSearchParams(location.search).get('device');
navigator.mediaDevices
  .getUserMedia({ video: { deviceId: { exact: device }, width: { ideal: 640 }, height: { ideal: 640 } } })
  .then((stream) => { document.getElementById('v').srcObject = stream; })
  .catch(() => document.body.classList.add('cam-error'));
