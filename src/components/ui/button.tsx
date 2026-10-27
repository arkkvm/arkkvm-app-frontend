/**
 * @Purpose:
 * @Descripttion:
 * @version:
 * @Author: zhanglei
 * @Date: 2025-07-15 19:03:08
 * @LastEditors: zhanglei
 * @LastEditTime: 2026-02-04 22:40:56
 */
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';
import { sizeVariants } from './variants';
import { stableTextChildren } from './stable-text-children';

// Extract shared CSS fragments for reuse across variants
const filledInteractive = [
  'hover:opacity-90 hover:saturate-110',
  'active:opacity-80 active:saturate-125',
  'data-[state=pressed]:opacity-80 data-[state=pressed]:saturate-125',
].join(' ');

const opacityInteractive = [
  'hover:opacity-95',
  'active:opacity-90',
  'data-[state=pressed]:opacity-90',
].join(' ');

const pressedOpacity = [
  'active:opacity-80',
  'data-[state=pressed]:opacity-80',
].join(' ');

const ghostPressedBgSecondary = [
  'active:bg-[var(--secondary-bg-color)]/80 font-[400]',
  'data-[state=pressed]:bg-[var(--secondary-bg-color)]/80',
].join(' ');

const defaultPressedGradient = [
  'active:bg-[linear-gradient(0deg,rgba(0,0,0,0.04)_0%,rgba(0,0,0,0.04)_100%),var(--bg-button-color)] active:border-[var(--border-color)]',
  'data-[state=pressed]:bg-[linear-gradient(0deg,rgba(0,0,0,0.04)_0%,rgba(0,0,0,0.04)_100%),var(--bg-button-color)] data-[state=pressed]:border-[var(--border-color)]',
].join(' ');

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[6px] text-sm font-[400] transition-all disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*=size-])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:ring-[3px] cursor-pointer',
  {
    variants: {
      variant: {
        default: [
          // default
          'bg-[var(--btn-outline-bg)] border border-[var(--btn-outline-border)] text-[var(--text-color)] shadow-xs',
          // hover
          'hover:bg-[var(--btn-outline-bg-hover)] hover:border-[var(--border-color)]',
          // pressed (mouse) and forced pressed via data-state
          defaultPressedGradient,
        ].join(' '),
        primary: [
          'bg-[var(--btn-filled-bg)] border border-[var(--btn-filled-border)] text-[var(--btn-filled-text)] shadow-xs',
          filledInteractive,
        ].join(' '),
        outline: [
          'border border-[var(--button-outlined-base-border-color)] bg-[var(--button-outlined-base-bg-color)] text-[var(--btn-filled-text)] shadow-xs',
          opacityInteractive,
        ].join(' '),
        secondary: [
          'bg-[var(--secondary-bg-color)] text-[var(--text-color)] shadow-xs',
          opacityInteractive,
        ].join(' '),
        ghost: [
          'hover:bg-[var(--secondary-bg-color)] hover:opacity-95',
          ghostPressedBgSecondary,
        ].join(' '),
        destructive: [
          'bg-[var(--btn-filled-bg-danger)] border border-[var(--btn-filled-bg-danger)] text-[var(--btn-filled-text)] shadow-xs',
          filledInteractive,
        ].join(' '),
        link: [
          'text-[var(--btn-primary-bg)] underline-offset-4 hover:underline',
          pressedOpacity,
        ].join(' '),
        text: [
          'bg-transparent border-transparent shadow-none text-[var(--text-color)]',
          'hover:opacity-80',
          'active:opacity-70',
        ].join(' '),
      },
      // semantic status colors
      status: {
        normal: '',
        success: '',
        warning: '',
        danger: '',
      },
      size: sizeVariants,
    },
    defaultVariants: {
      variant: 'default',
      status: 'normal',
      size: 'default',
    },
    compoundVariants: [
      // primary + status
      {
        variant: 'primary',
        status: 'success',
        className: [
          'bg-[var(--status-color-01)]',
          'border-[var(--status-color-01)]',
          'text-[var(--btn-filled-text)]',
        ].join(' '),
      },
      {
        variant: 'primary',
        status: 'warning',
        className: [
          'bg-[var(--btn-filled-bg-warning)]',
          'border-[var(--btn-filled-bg-warning)]',
          'text-[var(--btn-filled-text)]',
        ].join(' '),
      },
      {
        variant: 'primary',
        status: 'danger',
        className: [
          'bg-[var(--btn-filled-bg-danger)]',
          'border-[var(--btn-filled-bg-danger)]',
          'text-[var(--btn-filled-text)]',
        ].join(' '),
      },

      // outline + status
      {
        variant: 'outline',
        status: 'success',
        className: [
          'border',
          'border-[var(--status-color-01)]',
          'text-[var(--status-color-01)]',
        ].join(' '),
      },
      {
        variant: 'outline',
        status: 'warning',
        className: [
          'border',
          'border-[var(--btn-outline-border-warning)]',
          'text-[var(--btn-outline-border-warning)]',
        ].join(' '),
      },
      {
        variant: 'outline',
        status: 'danger',
        className: [
          'border',
          'border-[var(--btn-outline-border-danger)]',
          'bg-red-50 dark:bg-[#450A0A]',
          'hover:bg-red-100 dark:hover:bg-[rgba(184,62,62,0.3)]',
        ].join(' '),
      },

      // default + status (outlined style base)
      {
        variant: 'default',
        status: 'success',
        className: ['border', 'border-[var(--btn-outline-border)] bg-[var(--btn-outline-bg)]'].join(' '),
      },
      {
        variant: 'default',
        status: 'warning',
        className: [
          'border',
          'border-[var(--btn-outline-border-warning)]',
        ].join(' '),
      },
      {
        variant: 'default',
        status: 'danger',
        className: ['border', 'border-[var(--btn-outline-border-danger)]'].join(
          ' '
        ),
      },

      // link + status
      {
        variant: 'link',
        status: 'success',
        className: 'text-[var(--status-color-01)]',
      },
      {
        variant: 'link',
        status: 'warning',
        className: 'text-[var(--btn-filled-bg-warning)]',
      },
      {
        variant: 'link',
        status: 'danger',
        className: 'text-[var(--btn-filled-bg-danger)]',
      },

      // ghost + status (tint by text color)
      {
        variant: 'ghost',
        status: 'success',
        className: 'text-[var(--status-color-01)]',
      },
      {
        variant: 'ghost',
        status: 'warning',
        className: 'text-[var(--btn-outline-border-warning)]',
      },
      {
        variant: 'ghost',
        status: 'danger',
        className: 'text-[var(--btn-outline-border-danger)]',
      },
    ],
  }
);
function Button({
  className,
  variant,
  size,
  status,
  asChild = false,
  loading = false,
  pressed = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    loading?: boolean
    /** Force the button to display pressed state visually (e.g. toggle buttons) */
    pressed?: boolean
  }) {
  const Comp = asChild ? Slot : 'button';

  // Safely extract onClick and only forward if it's a function
  const { onClick, disabled, children, ...rest } = props as {
    onClick?: unknown
    disabled?: boolean
    children?: React.ReactNode
  } & Record<string, unknown>;
  const isDisabled = Boolean(disabled || loading);
  const safeOnClick =
    !loading && typeof onClick === 'function'
      ? (onClick as React.MouseEventHandler<HTMLButtonElement>)
      : undefined;

  return (
    <Comp
      data-slot="button"
      // Map pressed prop to data-state and aria-pressed for accessibility
      data-state={pressed ? 'pressed' : undefined}
      aria-pressed={pressed || undefined}
      className={cn(buttonVariants({ variant, size, status, className }))}
      onClick={safeOnClick}
      aria-busy={loading || undefined}
      disabled={isDisabled}
      {...rest}
    >
      {asChild ? children : <>
      {loading ? (
        <span
          aria-hidden="true"
          className="mr-2 inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent align-[-0.125em]"
        />
      ) : null}
      {stableTextChildren(children)}
      </>}
    </Comp>
  );
}

export { Button, buttonVariants };
