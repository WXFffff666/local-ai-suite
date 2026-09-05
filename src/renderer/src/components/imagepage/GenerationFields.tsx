/** todo20 — 生成参数表单字段（prompt/negative/尺寸/步数/CFG/seed/模型） */
export type GenerationFieldsValue = {
  prompt: string
  negative: string
  width: number
  height: number
  steps: number
  cfg: number
  seed: number
  model: string
}

export type GenerationFieldsProps = {
  value: GenerationFieldsValue
  onChange: (patch: Partial<GenerationFieldsValue>) => void
  disabled?: boolean
  /** 阶段4：已注册画图模型（diffusion/）— 提供时渲染图形化下拉 */
  modelOptions?: readonly string[]
}

export function GenerationFields({ value, onChange, disabled, modelOptions }: GenerationFieldsProps): React.JSX.Element {
  const numField = (label: string, key: 'width' | 'height' | 'steps', min: number): React.JSX.Element => (
    <label className="las-img-field">
      {label}
      <input
        type="number"
        min={min}
        value={value[key]}
        onChange={(e) => onChange({ [key]: Number(e.target.value) } as Partial<GenerationFieldsValue>)}
        disabled={disabled}
      />
    </label>
  )

  return (
    <>
      <label className="las-img-field">
        提示词 prompt
        <textarea rows={3} value={value.prompt} onChange={(e) => onChange({ prompt: e.target.value })} disabled={disabled} />
      </label>
      <label className="las-img-field">
        反向提示词 negative
        <textarea rows={2} value={value.negative} onChange={(e) => onChange({ negative: e.target.value })} disabled={disabled} />
      </label>
      <div className="las-img-row">
        {numField('宽', 'width', 64)}
        {numField('高', 'height', 64)}
        {numField('步数', 'steps', 1)}
      </div>
      <div className="las-img-row">
        <label className="las-img-field">
          CFG
          <input type="number" min={0} step={0.5} value={value.cfg} onChange={(e) => onChange({ cfg: Number(e.target.value) })} disabled={disabled} />
        </label>
        <label className="las-img-field">
          种子 seed
          <input type="number" min={-1} value={value.seed} onChange={(e) => onChange({ seed: Number(e.target.value) })} disabled={disabled} />
        </label>
        <label className="las-img-field">
          模型
          {modelOptions !== undefined && modelOptions.length > 0 ? (
            <select
              value={value.model}
              onChange={(e) => onChange({ model: e.target.value })}
              disabled={disabled}
              data-testid="img-model-select"
            >
              <option value="">自动选择（按显存）</option>
              {modelOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : (
            <input type="text" value={value.model} onChange={(e) => onChange({ model: e.target.value })} placeholder="自动（或手填模型名）" disabled={disabled} />
          )}
        </label>
      </div>
    </>
  )
}

export default GenerationFields
