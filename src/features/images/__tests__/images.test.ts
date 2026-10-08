import { describe, expect, it } from 'vitest'
import { EntityStore } from '../../../core/entity/store'
import { createAnnotation, updateAnnotationSelector } from '../../../core/resources/annotations'
import '../../../core/resources/types'
import { annotateImage, createImage, extensionFor, labelFromUrl, normalizeBox, otherAnnotationsOf, regionAnnotationsOf } from '../images'

const PNG = 'data:image/png;base64,iVBORw0KGgo='

describe('images', () => {
  it('createImage derives a label from the url and keeps only known fields', () => {
    const s = new EntityStore()
    const e = createImage(s, { src: 'https://x.y/pics/Cat%20photo.jpeg', url: 'https://x.y/pics/Cat%20photo.jpeg', width: 10, height: 5 })
    expect(e.label).toBe('Cat photo')
    expect(e.data).toEqual({ src: 'https://x.y/pics/Cat%20photo.jpeg', url: 'https://x.y/pics/Cat%20photo.jpeg', width: 10, height: 5 })
    expect(createImage(s, { src: PNG }).label).toBe('Untitled image')
    expect(labelFromUrl('nope')).toBe('')
  })

  it('normalizeBox clamps, rounds, and rejects empty boxes', () => {
    expect(normalizeBox({ x: 10.4, y: 10.6, width: 20, height: 20 }, 100, 100)).toEqual({ x: 10, y: 11, width: 20, height: 20 })
    // Negative size (drawn right-to-left) flips.
    expect(normalizeBox({ x: 50, y: 50, width: -20, height: -10 }, 100, 100)).toEqual({ x: 30, y: 40, width: 20, height: 10 })
    // Off the edge is clamped.
    expect(normalizeBox({ x: 90, y: -5, width: 30, height: 30 }, 100, 100)).toEqual({ x: 90, y: 0, width: 10, height: 25 })
    expect(normalizeBox({ x: 10, y: 10, width: 1, height: 1 }, 100, 100)).toBeNull()
    expect(normalizeBox({ x: 200, y: 200, width: 10, height: 10 }, 100, 100)).toBeNull()
  })

  it('annotateImage stores a region selector; boxes can be moved', () => {
    const s = new EntityStore()
    const img = createImage(s, { src: 'https://x.y/a.png', url: 'https://x.y/a.png', width: 100, height: 80 })
    const a = annotateImage(s, img, { x: 5, y: 6, width: 30, height: 20 }, 'a thing', ['found'])
    expect(a.type).toBe('annotation')
    expect(a.data).toMatchObject({ annotationType: 'image', comment: 'a thing', imageUrl: 'https://x.y/a.png' })
    const regions = regionAnnotationsOf(s, img.id)
    expect(regions).toHaveLength(1)
    expect(regions[0].region).toEqual({ kind: 'region', x: 5, y: 6, width: 30, height: 20 })
    expect(otherAnnotationsOf(s, img.id)).toHaveLength(0)

    updateAnnotationSelector(s, regions[0].relationshipId, { kind: 'region', x: 1, y: 2, width: 3, height: 4 })
    expect(regionAnnotationsOf(s, img.id)[0].region).toEqual({ kind: 'region', x: 1, y: 2, width: 3, height: 4 })

    createAnnotation(s, img.id, undefined, { comment: 'whole', annotationType: 'image' })
    expect(otherAnnotationsOf(s, img.id)).toHaveLength(1)
    expect(regionAnnotationsOf(s, img.id)).toHaveLength(1)

    // Inline images don't copy the data url into the annotation.
    const inline = createImage(s, { src: PNG, width: 10, height: 10 })
    expect(annotateImage(s, inline, { x: 0, y: 0, width: 5, height: 5 }, 'x').data.imageUrl).toBeUndefined()
  })

  it('extensionFor', () => {
    const s = new EntityStore()
    expect(extensionFor(createImage(s, { src: PNG }))).toBe('.png')
    expect(extensionFor(createImage(s, { src: 'data:image/jpeg;base64,AAA' }))).toBe('.jpg')
    expect(extensionFor(createImage(s, { src: 'https://x.y/a', mimeType: 'image/svg+xml' }))).toBe('.svg')
    expect(extensionFor(createImage(s, { src: 'https://x.y/a' }))).toBe('')
  })
})
