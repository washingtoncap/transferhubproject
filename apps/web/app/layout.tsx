import type {Metadata} from 'next';
import './globals.css';
export const metadata:Metadata={title:'TransferHub | Platform foundation',description:'TransferHub sandbox platform foundation. Financial services are not enabled.'};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>;}
