import type { Metadata,Viewport } from 'next';
import './globals.css';
export const metadata:Metadata={title:'Vincent | Quản lý thu tiền',description:'Quản lý thu tiền nhà và giao dịch chuyển khoản',applicationName:'Vincent',appleWebApp:{capable:true,title:'Vincent',statusBarStyle:'default'},manifest:'/manifest.webmanifest'};
export const viewport:Viewport={width:'device-width',initialScale:1,viewportFit:'cover',themeColor:'#f7f9fb'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="vi"><body>{children}</body></html>}
