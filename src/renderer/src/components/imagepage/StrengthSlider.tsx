/** todo20 — img2img 重绘强度滑杆 (0..1, step .05, 默认 .75) */
export type StrengthSliderProps = {
  value: number
  onChange: (v: number) => void
  disabled?: boolean
}

export const STRENGTH_MIN = 0
export const STRENGTH_MAX = 1
export const STRENGTH_STEP = 0.05

export function StrengthSlider({ value, onChange, disabled }: StrengthSliderProps): React.JSX.Element {
  return (
    <label className="las-img-strength">
      <span className="las-img-strength-label">重绘强度 strength</span>
      <input
        type="range"
        min={STRENGTH_MIN}
        max={STRENGTH_MAX}
        step={STRENGTH_STEP}
        value={value}
        disabled={disabled}
        aria-label="重绘强度"
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <output className="las-img-strength-value">{value.toFixed(2)}</output>
    </label>
  )
}

export default StrengthSlider
