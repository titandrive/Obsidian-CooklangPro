import type { CooklangRecipe } from '@cooklang/cooklang';
import { buildMetaPills, type PillKind } from './heroModel';
import { getRecipeImageUrls } from './recipeImages';

export interface MetadataEntry {
    key: string;
    value: string;
}

const PILL_KEYS: Partial<Record<string, PillKind>> = {
    servings: 'servings',
    tags: 'tag',
    source: 'source',
    author: 'author',
    difficulty: 'difficulty',
    course: 'course',
    cuisine: 'cuisine',
    diet: 'diet',
};

/**
 * CooklangPro's own properties, shown elsewhere in the view: `recipe` marks the note as a recipe, `photo` is the
 * hero image, `favorite` and `rating` are the heart and stars, `added` is the date under the title.
 */
const OWN_KEYS = new Set(['recipe', 'photo', 'favorite', 'rating', 'added']);

function hasText(value: unknown): boolean {
    return value != null && String(value).trim().length > 0;
}

function hasTimePart(recipe: CooklangRecipe, part: 'prep_time' | 'cook_time'): boolean {
    if (!recipe.time || typeof recipe.time !== 'object') return false;
    return recipe.time[part] != null;
}

/** Whether this exact, case-sensitive raw key is represented elsewhere in the preview. */
function isHandledMetadataKey(
    recipe: CooklangRecipe,
    key: string,
    pillKinds: ReadonlySet<PillKind>,
): boolean {
    if (OWN_KEYS.has(key)) return true;
    if (key === 'title') return hasText(recipe.title);
    if (key === 'description') return hasText(recipe.description);
    if (key === 'time') {
        return pillKinds.has('time') && typeof recipe.time === 'number';
    }
    if (key === 'prep time') return pillKinds.has('time') && hasTimePart(recipe, 'prep_time');
    if (key === 'cook time') return pillKinds.has('time') && hasTimePart(recipe, 'cook_time');
    if (key === 'image') return getRecipeImageUrls(recipe.images).length > 0;

    const pillKind = PILL_KEYS[key];
    return pillKind !== undefined && pillKinds.has(pillKind);
}

export function getAdditionalMetadata(recipe: CooklangRecipe): MetadataEntry[] {
    const pillKinds = new Set(buildMetaPills(recipe, null).map(pill => pill.kind));

    return Array.from(recipe.rawMetadata, ([key, value]) => ({
        key: String(key),
        value: String(value),
    }))
        .filter(entry => !isHandledMetadataKey(recipe, entry.key, pillKinds));
}
