'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function ConnectorsRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/settings/bot'); }, [router]);
  return null;
}
