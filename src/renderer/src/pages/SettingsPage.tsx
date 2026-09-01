/** Settings 页占位 — 由 todo16（密钥/modelsDir/主题语言）接入实装 */
export function SettingsPage(): React.JSX.Element {
  return (
    <section className="las-page" aria-labelledby="page-title-settings">
      <h1 id="page-title-settings" className="las-page-title">
        Settings
      </h1>
      <p className="las-page-subtitle">应用设置</p>
      <div className="las-page-card">
        占位页面 — 由 todo 16（safeStorage 密钥、modelsDir、主题/语言持久化）实装。
      </div>
    </section>
  )
}

export default SettingsPage
