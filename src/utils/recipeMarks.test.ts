import { describe, expect, it } from 'vitest';
import type { CooklangRecipe } from '@cooklang/cooklang';
import { photoLinkText, readRecipeMarks } from './recipeMarks';

const recipe = (meta: Record<string, unknown>) => ({ rawMetadata: new Map(Object.entries(meta)) }) as unknown as CooklangRecipe;

describe('readRecipeMarks', () => {
    it('reads favorite and rating', () => {
        expect(readRecipeMarks(recipe({ favorite: true, rating: 4 }))).toEqual({ favorite: true, rating: 4 });
    });
    it('ignores missing or invalid values', () => {
        expect(readRecipeMarks(recipe({}))).toEqual({ favorite: false, rating: 0 });
        expect(readRecipeMarks(recipe({ favorite: 'yes', rating: 7 }))).toEqual({ favorite: false, rating: 0 });
        expect(readRecipeMarks(recipe({ rating: 2.5 }))).toEqual({ favorite: false, rating: 0 });
    });
});

describe('photoLinkText', () => {
    it('unwraps wiki links', () => {
        expect(photoLinkText(recipe({ photo: '[[Curry.jpg]]' }))).toBe('Curry.jpg');
        expect(photoLinkText(recipe({ photo: '![[Photos/Curry.jpg|alt]]' }))).toBe('Photos/Curry.jpg');
        expect(photoLinkText(recipe({ photo: 'Curry.jpg' }))).toBe('Curry.jpg');
    });
    it('returns null without a photo', () => {
        expect(photoLinkText(recipe({}))).toBeNull();
        expect(photoLinkText(recipe({ photo: 3 }))).toBeNull();
    });
});
