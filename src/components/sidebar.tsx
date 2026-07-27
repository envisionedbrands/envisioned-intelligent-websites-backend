'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { ThemeToggle } from '@/components/theme-toggle';

type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
  disabled?: boolean;
};

const NAV_ITEMS: NavItem[] = [
  {
    href: '/content',
    label: 'Content',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 256 256" fill="currentColor">
        <path d="M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40ZM40,56H216V96H40ZM40,200V112H216v88Z" />
      </svg>
    ),
  },
  {
    href: '/agent',
    label: 'Operator',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 256 256" fill="currentColor">
        <path d="M96,240a8,8,0,0,1-7.92-9.13L100.77,146,40.66,123.42a8,8,0,0,1-3-13.06l112-112a8,8,0,0,1,13.51,7L150.94,90.83,215.34,115a8,8,0,0,1,2.32,13.63l-116,108A8,8,0,0,1,96,240Zm-36.9-129.36,54,20.28a8,8,0,0,1,5.1,8.87l-10.06,66L193.44,120,131,96.61A8,8,0,0,1,126,87.72l9.36-59.72Z" />
      </svg>
    ),
  },
  {
    href: '/crm',
    label: 'CRM',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 256 256" fill="currentColor">
        <path d="M224,200h-8V40a8,8,0,0,0-8-8H152a8,8,0,0,0-8,8V80H96a8,8,0,0,0-8,8v40H48a8,8,0,0,0-8,8v64H24a8,8,0,0,0,0,16H224a8,8,0,0,0,0-16ZM160,48h40V200H160ZM104,96h40V200H104ZM56,144H88v56H56Z" />
      </svg>
    ),
  },
  {
    href: '/crm/leads',
    label: 'Leads',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 256 256" fill="currentColor">
        <path d="M230.92,212c-15.23-26.33-38.7-45.21-66.09-54.16a72,72,0,1,0-73.66,0C63.78,166.78,40.31,185.66,25.08,212a8,8,0,1,0,13.85,8C55.71,192.47,78.63,176,128,176s72.29,16.47,89.07,44a8,8,0,1,0,13.85-8ZM72,96a56,56,0,1,1,56,56A56.06,56.06,0,0,1,72,96Z" />
      </svg>
    ),
  },
  {
    href: '/crm/pipeline',
    label: 'Pipeline',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 256 256" fill="currentColor">
        <path d="M104,32H56A16,16,0,0,0,40,48V208a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V48A16,16,0,0,0,104,32Zm0,176H56V48h48ZM200,32H152a16,16,0,0,0-16,16V136a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V48A16,16,0,0,0,200,32Zm0,104H152V48h48Z" />
      </svg>
    ),
  },
  {
    href: '/crm/funnel',
    label: 'Funnel',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 256 256" fill="currentColor">
        <path d="M230.6,49.53A15.81,15.81,0,0,0,216,40H40A16,16,0,0,0,28.19,66.76l.08.09L96,139.17V216a16,16,0,0,0,24.87,13.32l32-21.34A16,16,0,0,0,160,194.66V139.17l67.73-72.32.08-.09A15.8,15.8,0,0,0,230.6,49.53ZM144,132.84V194.66l-32,21.34V132.84L40,56H216Z" />
      </svg>
    ),
  },
  {
    href: '/crm/workflows',
    label: 'Email',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 256 256" fill="currentColor">
        <path d="M224,48H32a8,8,0,0,0-8,8V192a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A8,8,0,0,0,224,48ZM203.43,64,128,133.15,52.57,64ZM216,192H40V74.19l82.59,75.71a8,8,0,0,0,10.82,0L216,74.19V192Z" />
      </svg>
    ),
  },
  {
    href: '/crm/settings',
    label: 'Setup',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 256 256" fill="currentColor">
        <path d="M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Zm88-29.84q.06-2.16,0-4.32l14.92-18.64a8,8,0,0,0,1.48-7.06,107.21,107.21,0,0,0-10.88-26.25,8,8,0,0,0-6-3.93l-23.72-2.64q-1.48-1.56-3-3L186,40.54a8,8,0,0,0-3.94-6,107.71,107.71,0,0,0-26.25-10.87,8,8,0,0,0-7.06,1.49L130.16,40Q128,40,125.84,40L107.2,25.11a8,8,0,0,0-7.06-1.48A107.6,107.6,0,0,0,73.89,34.51a8,8,0,0,0-3.93,6L67.32,64.27q-1.56,1.49-3,3L40.54,70a8,8,0,0,0-6,3.94,107.71,107.71,0,0,0-10.87,26.25,8,8,0,0,0,1.49,7.06L40,125.84Q40,128,40,130.16L25.11,148.8a8,8,0,0,0-1.48,7.06,107.21,107.21,0,0,0,10.88,26.25,8,8,0,0,0,6,3.93l23.72,2.64q1.49,1.56,3,3L70,215.46a8,8,0,0,0,3.94,6,107.71,107.71,0,0,0,26.25,10.87,8,8,0,0,0,7.06-1.49L125.84,216q2.16.06,4.32,0l18.64,14.92a8,8,0,0,0,7.06,1.48,107.21,107.21,0,0,0,26.25-10.88,8,8,0,0,0,3.93-6l2.64-23.72q1.56-1.48,3-3L215.46,186a8,8,0,0,0,6-3.94,107.71,107.71,0,0,0,10.87-26.25,8,8,0,0,0-1.49-7.06Zm-16.1-6.5a73.93,73.93,0,0,1,0,8.68,8,8,0,0,0,1.74,5.48l14.19,17.73a91.57,91.57,0,0,1-6.23,15L207,175.71a8,8,0,0,0-5.1,2.64,74.11,74.11,0,0,1-6.14,6.14,8,8,0,0,0-2.64,5.1l-2.51,22.58a91.32,91.32,0,0,1-15,6.23l-17.74-14.19a8,8,0,0,0-5-1.75h-.48a73.93,73.93,0,0,1-8.68,0,8,8,0,0,0-5.48,1.74L120.52,218.4a91.57,91.57,0,0,1-15-6.23L103,189.59a8,8,0,0,0-2.64-5.1,74.11,74.11,0,0,1-6.14-6.14,8,8,0,0,0-5.1-2.64L66.54,173.2a91.32,91.32,0,0,1-6.23-15l14.19-17.74a8,8,0,0,0,1.74-5.48,73.93,73.93,0,0,1,0-8.68,8,8,0,0,0-1.74-5.48L60.31,103.11a91.57,91.57,0,0,1,6.23-15L89.12,85.6a8,8,0,0,0,5.1-2.64,74.11,74.11,0,0,1,6.14-6.14A8,8,0,0,0,103,71.72l2.51-22.58a91.32,91.32,0,0,1,15-6.23l17.74,14.19a8,8,0,0,0,5.48,1.74,73.93,73.93,0,0,1,8.68,0,8,8,0,0,0,5.48-1.74L175.6,42.91a91.57,91.57,0,0,1,15,6.23l2.51,22.58a8,8,0,0,0,2.64,5.1,74.11,74.11,0,0,1,6.14,6.14,8,8,0,0,0,5.1,2.64l22.58,2.51a91.32,91.32,0,0,1,6.23,15l-14.19,17.74A8,8,0,0,0,219.9,123.66Z" />
      </svg>
    ),
  },
];

export function Sidebar() {
  const pathname = usePathname();

  // Don't show sidebar on login page
  if (pathname === '/login') return null;

  return (
    <aside className="w-20 shrink-0 border-r border-minimal-border flex flex-col items-center py-6 gap-8">
      {/* Logo */}
      <div className="flex items-center justify-center mb-4">
        <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-white">
          Brave
        </span>
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-6 flex-1">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname?.startsWith(item.href) && item.href !== '#';
          const isDisabled = item.disabled;

          return (
            <Link
              key={item.label}
              href={isDisabled ? '#' : item.href}
              className={`flex flex-col items-center gap-1.5 transition-colors ${
                isActive
                  ? 'text-white'
                  : isDisabled
                  ? 'cursor-default opacity-35'
                  : 'text-minimal-muted hover:text-white'
              }`}
              onClick={isDisabled ? (e) => e.preventDefault() : undefined}
            >
              {item.icon}
              <span className="text-[9px] font-medium uppercase tracking-[0.15em]">
                {item.label}
              </span>
            </Link>
          );
        })}
      </nav>

      {/* Theme toggle */}
      <ThemeToggle />

      {/* Version */}
      <div className="text-[8px] text-minimal-muted uppercase tracking-widest">
        v0.1
      </div>
    </aside>
  );
}
