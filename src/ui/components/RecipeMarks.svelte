<script lang="ts">
    import { setIcon } from 'obsidian';
    import type { RecipeRenderModel } from '../types';
    import { readRecipeMarks } from '../../utils/recipeMarks';

    let { model }: { model: RecipeRenderModel } = $props();

    // Shown at once on click; the file change that follows re-renders with the saved values.
    let pending = $state<{ favorite?: boolean; rating?: number }>({});
    let saved = $derived(readRecipeMarks(model.recipe));
    let favorite = $derived(pending.favorite ?? saved.favorite);
    let rating = $derived(pending.rating ?? saved.rating);
    let hover = $state(0);

    $effect(() => {
        // A new parse means the file caught up; drop the optimistic values.
        void model.recipe;
        pending = {};
    });

    function icon(node: HTMLElement, name: string) {
        setIcon(node, name);
    }

    function save(key: 'favorite' | 'rating', value: boolean | number) {
        if (!model.file || !model.host.setRecipeMark) return;
        pending = { ...pending, [key]: value };
        void model.host.setRecipeMark(model.file, key, value);
    }
</script>

{#if model.interactive && model.file && model.host.setRecipeMark}
    <div class="recipe-importer-rating">
        <button
            type="button"
            class="recipe-importer-favorite clickable-icon"
            class:is-favorite={favorite}
            aria-pressed={favorite}
            aria-label={favorite ? 'Remove from favorites' : 'Add to favorites'}
            use:icon={'heart'}
            onclick={() => save('favorite', !favorite)}
        ></button>
        <div class="recipe-importer-stars" role="radiogroup" aria-label="Rating" tabindex="-1" onmouseleave={() => (hover = 0)}>
            {#each [1, 2, 3, 4, 5] as n}
                <button
                    type="button"
                    role="radio"
                    class="recipe-importer-rating-star clickable-icon"
                    class:is-filled={n <= (hover || rating)}
                    aria-checked={n === rating}
                    aria-label={n === rating ? 'Clear rating' : `Rate ${n} star${n === 1 ? '' : 's'}`}
                    use:icon={'star'}
                    onmouseenter={() => (hover = n)}
                    onclick={() => save('rating', n === rating ? 0 : n)}
                ></button>
            {/each}
        </div>
    </div>
{/if}
