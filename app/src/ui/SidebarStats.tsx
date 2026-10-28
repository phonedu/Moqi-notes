import { formatCompactCount, type HeatmapWeek, type SidebarStats } from '@moqi/editor'

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

/** 月份标在「该月第一次出现的那一列」；12 周通常只有 2–3 个标签。 */
function monthLabels(weeks: HeatmapWeek[]): Array<string | null> {
  let previous = ''
  return weeks.map((week) => {
    const first = week.find((day) => !day.future) ?? week[0]
    if (!first) return null
    const month = first.key.slice(0, 7)
    if (month === previous) return null
    previous = month
    return `${Number(first.key.slice(5, 7))}月`
  })
}

/** 侧栏统计区（`R09-PRIN-13`）：统计三格在上，热力图在下；左星期、下月份。 */
export function SidebarStatsView({ stats }: { stats: SidebarStats }) {
  const label = `近 12 周有 ${stats.activeDays} 天有改动，最多 ${stats.peak} 个页面`
  const months = monthLabels(stats.weeks)
  return (
    <div className="sb-stats" role="group" aria-label="笔记统计">
      <div className="sb-figures">
        <div className="sb-figure" title={`${stats.pages} 个页面`}>
          <b>{formatCompactCount(stats.pages)}</b>
          <span>页面</span>
        </div>
        <div className="sb-figure" title={`${stats.tags} 个标签`}>
          <b>{formatCompactCount(stats.tags)}</b>
          <span>标签</span>
        </div>
        <div className="sb-figure" title={`${stats.chars} 字`}>
          <b>{formatCompactCount(stats.chars)}</b>
          <span>字</span>
        </div>
      </div>
      <div className="sb-sec sb-stats-sec">近 12 周 · 页面活跃</div>
      <div className="sb-heat-body">
        <div className="sb-heat-weekdays" aria-hidden="true">
          {WEEKDAYS.map((day) => <span className="sb-heat-weekday" key={day}>{day}</span>)}
        </div>
        <div className="sb-heat" role="img" aria-label={label}>
          {stats.weeks.map((week, weekIndex) => (
            <div className="sb-heat-week" key={weekIndex}>
              {week.map((day) => (
                <span
                  key={day.key}
                  className={`sb-heat-day${day.future ? ' is-future' : ''}`}
                  data-level={day.level}
                  title={day.future ? undefined : `${day.key} · ${day.count} 个页面有改动`}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="sb-heat-months" aria-hidden="true">
        <span className="sb-heat-month-spacer" />
        <div className="sb-heat-month-grid">
          {months.map((month, index) => <span className="sb-heat-month" key={index}>{month}</span>)}
        </div>
      </div>
    </div>
  )
}
