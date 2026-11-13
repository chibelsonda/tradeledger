import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import type { PaymentRequest } from '@/lib/database.types'
import { formatCurrency } from '@/lib/format'
import {
  buildMonthlyFinancialData,
  buildPaymentStatusData,
} from '@/features/operations/overview-chart-data'

interface OverviewChartsProps {
  paymentRequests: PaymentRequest[]
}

const tooltipStyle = {
  border: '1px solid #dce2de',
  borderRadius: 0,
  background: '#ffffff',
  boxShadow: '0 14px 32px rgba(19, 37, 31, 0.12)',
  color: '#0b1e18',
  fontSize: 12,
}

function compactCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value / 100)
}

export function OverviewCharts({ paymentRequests }: OverviewChartsProps) {
  const currency = paymentRequests[0]?.currency ?? 'usd'
  const monthlyData = buildMonthlyFinancialData(paymentRequests)
  const statusData = buildPaymentStatusData(paymentRequests)
  const hasFinancialActivity = monthlyData.some(
    (point) => point.gross > 0 || point.net > 0,
  )
  const statusChartData =
    statusData.length > 0
      ? statusData
      : [{ key: 'empty', label: 'No activity', count: 1, color: '#e5e9e6' }]

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(20rem,0.75fr)]">
      <section
        aria-labelledby="financial-activity-title"
        className="min-w-0 border border-ink/10 bg-white p-5 shadow-[0_14px_36px_rgba(19,37,31,0.05)] sm:p-6"
      >
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.17em] text-forest/75">
              Six-month view
            </p>
            <h2
              id="financial-activity-title"
              className="mt-1 text-lg font-extrabold tracking-[-0.025em] text-ink"
            >
              Financial activity
            </h2>
            <p className="mt-1 text-xs leading-5 font-medium text-ink/65">
              Request value grouped by creation month
            </p>
          </div>
          <div className="flex items-center gap-4 text-xs font-semibold text-ink/70">
            <span className="inline-flex items-center gap-2">
              <span className="size-2.5 bg-forest" />
              Gross
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="size-2.5 bg-mint" />
              Net
            </span>
          </div>
        </div>

        <div className="relative mt-5 h-72 min-w-0">
          <BarChart
            responsive
            accessibilityLayer
            data={monthlyData}
            margin={{ top: 8, right: 4, left: 0, bottom: 0 }}
            style={{ width: '100%', height: '100%' }}
          >
            <CartesianGrid vertical={false} stroke="#e3e8e5" />
            <XAxis
              dataKey="month"
              axisLine={false}
              tickLine={false}
              tick={{ fill: '#54645e', fontSize: 11, fontWeight: 600 }}
              dy={8}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              width={58}
              tick={{ fill: '#697771', fontSize: 10, fontWeight: 600 }}
              tickFormatter={(value: number) => compactCurrency(value, currency)}
            />
            <Tooltip
              cursor={{ fill: '#f4f5f1' }}
              contentStyle={tooltipStyle}
              labelFormatter={(_, payload) =>
                payload[0]?.payload.fullMonth ?? ''
              }
              formatter={(value, name) => [
                formatCurrency(Number(value ?? 0), currency),
                name === 'gross' ? 'Gross value' : 'Net value',
              ]}
            />
            <Bar
              dataKey="gross"
              fill="#153f34"
              maxBarSize={28}
              isAnimationActive={false}
            />
            <Bar
              dataKey="net"
              fill="#d8f78f"
              maxBarSize={28}
              isAnimationActive={false}
            />
          </BarChart>

          {!hasFinancialActivity && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center bg-white/72 px-6 text-center">
              <div>
                <p className="text-sm font-bold text-ink">No request value yet</p>
                <p className="mt-1 text-xs leading-5 font-medium text-ink/60">
                  Financial activity will appear after the first payment request.
                </p>
              </div>
            </div>
          )}
        </div>
      </section>

      <section
        aria-labelledby="workflow-status-title"
        className="min-w-0 border border-ink/10 bg-white p-5 shadow-[0_14px_36px_rgba(19,37,31,0.05)] sm:p-6"
      >
        <p className="text-[10px] font-bold uppercase tracking-[0.17em] text-forest/75">
          Current pipeline
        </p>
        <h2
          id="workflow-status-title"
          className="mt-1 text-lg font-extrabold tracking-[-0.025em] text-ink"
        >
          Workflow status
        </h2>
        <p className="mt-1 text-xs leading-5 font-medium text-ink/65">
          Payment requests by current state
        </p>

        <div className="relative mx-auto mt-4 h-52 w-full max-w-72">
          <PieChart
            responsive
            accessibilityLayer
            style={{ width: '100%', height: '100%' }}
          >
            <Pie
              data={statusChartData}
              dataKey="count"
              nameKey="label"
              innerRadius="66%"
              outerRadius="92%"
              paddingAngle={statusData.length > 1 ? 2 : 0}
              stroke="none"
              isAnimationActive={false}
            >
              {statusChartData.map((point) => (
                <Cell key={point.key} fill={point.color} />
              ))}
            </Pie>
            {statusData.length > 0 && (
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(value) => [
                  `${Number(value ?? 0)} request${Number(value ?? 0) === 1 ? '' : 's'}`,
                  'Count',
                ]}
              />
            )}
          </PieChart>
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
            <div>
              <p className="text-3xl font-extrabold tracking-[-0.04em] text-ink">
                {paymentRequests.length}
              </p>
              <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.14em] text-ink/55">
                Requests
              </p>
            </div>
          </div>
        </div>

        {statusData.length > 0 ? (
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
            {statusData.map((point) => (
              <li
                key={point.key}
                className="flex items-center justify-between gap-3 text-xs"
              >
                <span className="inline-flex min-w-0 items-center gap-2 font-semibold text-ink/70">
                  <span
                    aria-hidden="true"
                    className="size-2.5 shrink-0"
                    style={{ backgroundColor: point.color }}
                  />
                  <span className="truncate">{point.label}</span>
                </span>
                <span className="font-mono font-bold text-ink">{point.count}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-center text-xs leading-5 font-medium text-ink/60">
            Request statuses will appear as work moves through the pipeline.
          </p>
        )}
      </section>
    </div>
  )
}
