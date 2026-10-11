import { expect, test } from 'vitest'
import { declaredUsd, pathMatches } from '../price.ts'

test('the first source in order 1 to 5 wins', () => {
  const op = { 'x-payment-info': { offers: [{ amount: '30000' }], price: '$9' }, 'x-price-usd': '5' }
  expect(declaredUsd(op, { dimensions: [{ tiers: [{ price_usd: 7 }] }] })).toBe(0.03)
  expect(declaredUsd({ 'x-payment-info': { price: '$9' }, 'x-price-usd': '5' })).toBe(9)
})

test('the first offer with a non-empty amount gives micro-USD', () => {
  expect(declaredUsd({ 'x-payment-info': { offers: [{ amount: '' }, { amount: '10000' }] } })).toBe(0.01)
})

test('a payment-info price strips the dollar sign', () => {
  expect(declaredUsd({ 'x-payment-info': { price: '$0.05' } })).toBe(0.05)
})

test('a payment-info amount over 1000 is micro-USD', () => {
  expect(declaredUsd({ 'x-payment-info': { amount: 5000 } })).toBe(0.005)
  expect(declaredUsd({ 'x-payment-info': { amount: 2 } })).toBe(2)
})

test('the first solana accept gives micro-USD', () => {
  const accepts = [{ network: 'base', amount: '1' }, { network: 'solana-mainnet', amount: '20000' }]
  expect(declaredUsd({ 'x-payment-info': { accepts } })).toBe(0.02)
})

test('x-price-usd wins over x-price', () => {
  expect(declaredUsd({ 'x-price-usd': '3', 'x-price': '$1' })).toBe(3)
  expect(declaredUsd({ 'x-price': '$1' })).toBe(1)
})

test('the last tier of the first dimension, over its scale', () => {
  const tiers = [{ price_usd: 1 }, { price_usd: 2 }]
  expect(declaredUsd({}, { dimensions: [{ scale: 1000, tiers }] })).toBe(0.002)
  expect(declaredUsd({}, { dimensions: [{ tiers }] })).toBe(2)
})

test('nothing declared, or a price that is not a number, is null', () => {
  expect(declaredUsd({})).toBeNull()
  expect(declaredUsd({ 'x-price': 'free' })).toBeNull()
})

test('pathMatches fills braces with one non-empty segment', () => {
  expect(pathMatches('/a/{id}/b', '/a/42/b')).toBe(true)
  expect(pathMatches('a/{id}/b', '/a/42/b?x=1')).toBe(true)
  expect(pathMatches('/a/{id}/b', '/a/4/2/b')).toBe(false)
  expect(pathMatches('/a/{id}', '/a/')).toBe(false)
  expect(pathMatches('/a/b', '/a/c')).toBe(false)
})
