import type { CooklangRecipe } from '@cooklang/cooklang';

/** A recipe's favorite flag and 1-5 rating, from its `favorite` and `rating` properties. */
export interface RecipeMarks {
    favorite: boolean;
    rating: number;
}

function raw(recipe: CooklangRecipe, key: string): unknown {
    return recipe.rawMetadata instanceof Map ? recipe.rawMetadata.get(key) : undefined;
}

export function readRecipeMarks(recipe: CooklangRecipe): RecipeMarks {
    const rating = Number(raw(recipe, 'rating'));
    return {
        favorite: raw(recipe, 'favorite') === true,
        rating: Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : 0,
    };
}

/** The link text of a recipe's `photo` property (`"[[Name.jpg]]"` gives `Name.jpg`), or null. */
export function photoLinkText(recipe: CooklangRecipe): string | null {
    const value = raw(recipe, 'photo');
    if (typeof value !== 'string') return null;
    const link = value.trim().replace(/^!?\[\[/, '').replace(/\]\]$/, '').split('|')[0].trim();
    return link || null;
}
