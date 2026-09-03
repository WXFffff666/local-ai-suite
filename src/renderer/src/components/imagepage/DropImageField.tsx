import { useRef, type DragEvent } from 'react'

/**
 * todo20 — 拖放/点选导入底图。webUtils.getPathForFile 对合成/剪贴板图不可用，
 * 统一走 FileReader→dataURL→image:saveTempImage 主进程落盘拿绝对路径。
 * 组件只管选择与预览，dataURL 上传由页面完成。
 */
export type DropImageFieldProps = {
  label: string
  hint?: string
  /** 已选底图的本地预览 URL（dataURL 或 file URL），null 时显示占位 */
  previewURL: string | null
  onFile: (file: File) => void
  onClear?: () => void
  disabled?: boolean
}

export function DropImageField({ label, hint, previewURL, onFile, onClear, disabled }: DropImageFieldProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)

  const take = (files: FileList | null): void => {
    const file = files?.[0]
    if (file) onFile(file)
  }

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    if (disabled) return
    take(e.dataTransfer.files)
  }

  return (
    <div
      className={`las-img-drop${previewURL ? ' has-image' : ''}`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <div className="las-img-drop-head">
        <span className="las-img-drop-label">{label}</span>
        {previewURL !== null && onClear ? (
          <button type="button" className="las-img-drop-clear" onClick={onClear} disabled={disabled}>
            移除
          </button>
        ) : null}
      </div>
      {previewURL ? (
        <img className="las-img-drop-preview" src={previewURL} alt={`${label}预览`} />
      ) : (
        <button
          type="button"
          className="las-img-drop-zone"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
        >
          {hint ?? '拖入或点击选择 PNG'}
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/*"
        className="las-img-drop-input"
        data-testid="img-drop-input"
        disabled={disabled}
        onChange={(e) => {
          take(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}

export default DropImageField
