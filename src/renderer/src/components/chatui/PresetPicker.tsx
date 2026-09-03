/**
 * PresetPicker.tsx — todo15 预设选择器（输入框上方 chips）
 * 从 Chat.tsx 抽出的受控呈现层：点击 → onPick(preset)，填充逻辑留在 Chat。
 * title/description 语义与 src/presets/presets.ts 的 ChatPreset 一一对应。
 */
import type { ChatPreset } from '../../../../presets/presets'

export type PresetPickerProps = {
  presets: readonly ChatPreset[]
  onPick: (preset: ChatPreset) => void
}

export function PresetPicker({ presets, onPick }: PresetPickerProps): React.JSX.Element | null {
  if (presets.length === 0) return null
  return (
    <div className="las-preset-row" role="group" aria-label="chat presets">
      {presets.map((p) => (
        <button
          key={p.id}
          type="button"
          className="las-preset-chip"
          title={p.description}
          onClick={() => onPick(p)}
        >
          {p.title}
        </button>
      ))}
    </div>
  )
}

export default PresetPicker
