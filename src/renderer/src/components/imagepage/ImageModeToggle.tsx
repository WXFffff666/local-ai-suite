/** todo20 — 生图模式分段控件：文生图 / 图生图 / inpaint */
export type ImageMode = 'txt2img' | 'img2img' | 'inpaint'

export const IMAGE_MODE_LABELS: Record<ImageMode, string> = {
  txt2img: '文生图',
  img2img: '图生图',
  inpaint: 'inpaint',
}

export type ImageModeToggleProps = {
  value: ImageMode
  onChange: (mode: ImageMode) => void
  disabled?: boolean
}

export function ImageModeToggle({ value, onChange, disabled }: ImageModeToggleProps): React.JSX.Element {
  return (
    <div className="las-img-mode" role="group" aria-label="生成模式">
      {(Object.keys(IMAGE_MODE_LABELS) as ImageMode[]).map((mode) => (
        <button
          key={mode}
          type="button"
          className={`las-img-mode-btn${mode === value ? ' is-active' : ''}`}
          aria-pressed={mode === value}
          disabled={disabled}
          onClick={() => onChange(mode)}
        >
          {IMAGE_MODE_LABELS[mode]}
        </button>
      ))}
    </div>
  )
}

export default ImageModeToggle
