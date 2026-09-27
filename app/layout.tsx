import Link from 'next/link';
import './globals.css';

const NAV = [
  { href: '/', label: 'Command Center' },
  { href: '/exec', label: 'Executive' },
  { href: '/agents', label: 'Agent Registry' },
  { href: '/policy', label: 'Policy Studio' },
  { href: '/incidents', label: 'Incidents' },
  { href: '/investigation', label: 'Investigation Console' },
  { href: '/campaigns', label: 'Threat Graph' },
  { href: '/connectors', label: 'Connectors' },
  { href: '/marketplace', label: 'Marketplace' },
  { href: '/lab', label: 'Test Lab' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="topbar">
          <div className="brand mono">CX<span>TRUST</span> · Control Plane</div>
          <div className="nav" style={{ display: 'flex', gap: 2 }}>
            {NAV.map(n => (
              <Link key={n.href} href={n.href}>{n.label}</Link>
            ))}
            <Link href="/simulator">Attack Simulator</Link>
          </div>
          <div style={{ marginLeft: 'auto' }} className="pill pill-gray mono">DEMO DATA · SIMULATED INTERACTIONS</div>
        </div>
        {children}
      </body>
    </html>
  );
}