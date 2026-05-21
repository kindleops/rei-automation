import type { TemplateCategory } from '../../../lib/data/templateData'

export const TemplateUseCaseTabs = ({
  categories,
  value,
  onChange,
}: {
  categories: TemplateCategory[]
  value: string
  onChange: (slug: string) => void
}) => (
  <div className="nx-template-use-cases" role="tablist" aria-label="Template use case categories">
    <button
      type="button"
      role="tab"
      aria-selected={value === 'all'}
      className={`nx-template-use-case ${value === 'all' ? 'is-active' : ''}`}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onChange('all')
      }}
    >
      All
    </button>
    {categories.map((category) => (
      <button
        key={category.slug}
        type="button"
        role="tab"
        aria-selected={value === category.slug}
        className={`nx-template-use-case ${value === category.slug ? 'is-active' : ''}`}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onChange(category.slug)
        }}
      >
        <span>{category.label}</span>
        <small>{category.count}</small>
      </button>
    ))}
  </div>
)
