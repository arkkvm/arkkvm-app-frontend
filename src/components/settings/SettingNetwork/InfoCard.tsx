/**
 * @Purpose:
 * @Descripttion:
 * @version:
 * @Author: zhanglei
 * @Date: 2025-08-25 15:40:48
 * @LastEditors: zhanglei
 * @LastEditTime: 2026-06-09 19:09:11
 */
import { cn } from '@/lib/utils';
import React from 'react';

export type InfoItem = {
  label: React.ReactNode
  value: React.ReactNode
}

interface InfoCardProps {
  title: React.ReactNode
  items: InfoItem[]
  action?: React.ReactNode
  className?: string
  singleColumn?: boolean // Whether to render only one column
}

// Renders a titled card with a two-column key-value grid.
// Items are provided as a flat array; left/right columns are split by index parity for simplicity.
export default function InfoCard({
  title,
  items,
  action,
  className,
  singleColumn = false,
}: InfoCardProps) {

  return (
    <div
      className={cn(
        className
      )}
    >
      {
        title && (
          <div className="text-base  text-text">
            {title}
          </div>
        )
      }
      <div
        className={cn(
          'font-[10px]',
          singleColumn
            ? 'space-y-2'
            : 'grid grid-cols-1 sm:grid-cols-2 gap-x-[16px]'
        )}
      >
        {singleColumn ? (
          // Single-column layout: render all items directly
          items.map((it, idx) => (
            <Row key={idx} label={it.label} value={it.value} />
          ))
        ) : (
          // Two-column layout: split into left and right columns
          <>
              {items.map((it, idx) => (
                <Row key={idx} label={it.label} value={it.value} />
              ))}

          </>
        )}
      </div>

      {action ? <div className="mt-4 flex justify-end">{action}</div> : null}
    </div>
  );
}

function Row({
  label,
  value,
}: {
  label: React.ReactNode
  value: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between text-sm border-border border-b-[0.02px] py-[12px]">
      <span className="text-inactive-text ">{label}</span>
      <span translate="no" className="notranslate ml-[10px] text-text font-medium">
        {value}
      </span>
    </div>
  );
}
