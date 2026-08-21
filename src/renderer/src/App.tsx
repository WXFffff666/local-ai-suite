function App(): React.JSX.Element {
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 32, lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 28, margin: 0 }}>Local AI Suite</h1>
      <p style={{ color: '#666', margin: '8px 0 16px' }}>
        本地模型一键安装与离线工作流套件 — 基座已就绪（T1 scaffold）。
      </p>
      <ul style={{ color: '#333' }}>
        <li>Electron 43 + electron-vite 5 + React 19 + TS 5.9</li>
        <li>后续 T2 将接入模型文件夹与工作流注册</li>
        <li>所有侧车仅 127.0.0.1，运行时零公网依赖</li>
      </ul>
      <p style={{ marginTop: 20, fontSize: 12, color: '#999' }}>
        preload ping: {typeof window !== 'undefined' && 'api' in window ? 'ok' : 'preload not yet bridged'}
      </p>
    </div>
  )
}

export default App
