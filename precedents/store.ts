export { distilled, filed, keep, newestMerged, precedents, source, threads, undistilled } from '../store/precedents.ts'

export interface Source { repo: string; number: number; title: string; merged_at: string | null; merger: string | null; files: string[]; issues: number[] }

export interface Thread { kind: string; author: string; role: string; text: string; path: string | null; line: number | null; url: string }

export interface Precedent { area: string; decision: string; why: string; said_by: string; role: 'maintainer' | 'contributor'; source: string }
