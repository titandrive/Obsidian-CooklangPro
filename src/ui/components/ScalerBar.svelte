<script lang="ts">
    import { clampServings } from '../../utils/scaling';
    import type { RecipeRenderModel } from '../types';

    let { model }: { model: RecipeRenderModel } = $props();
    let showScaler = $derived(
        model.settings.showServingsScaler
        && model.state.baseServings !== null
        && model.state.displayServings !== null,
    );

    // Without a scaler (servings missing, not a number like "4-6", or the scaler turned off): the servings as
    // written, or that there are none.
    let servingsText = $derived.by(() => {
        const raw = model.recipe.servings == null ? '' : String(model.recipe.servings).trim();
        if (!raw) return 'Servings not set';
        const n = Number(raw);
        return Number.isFinite(n) ? `${raw} ${n === 1 ? 'serving' : (model.settings.servingsLabel || 'servings')}` : `Serves ${raw}`;
    });

    function scrollTo(event: MouseEvent, selector: string): void {
        event.preventDefault();
        const current = event.currentTarget as HTMLElement;
        current.closest('.cook-rich')
            ?.querySelector(selector)
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
</script>

<nav class="cook-bar" aria-label="Recipe sections and servings">
    <div class="cook-bar-nav">
        <a class="cook-bar-link" href="#cook-ingredients" onclick={(event) => scrollTo(event, '#cook-ingredients')}>
            {model.settings.ingredientLabel || 'Ingredients'}
        </a>
        <a class="cook-bar-link" href="#cook-steps" onclick={(event) => scrollTo(event, '#cook-steps')}>
            {model.settings.methodLabel || 'Steps'}
        </a>
    </div>

    {#if showScaler && model.state.displayServings !== null}
        <div class="cook-stepper">
            <button
                type="button"
                class="cook-stepper-btn"
                aria-label="Fewer servings"
                disabled={model.state.displayServings <= 1}
                onclick={() => model.callbacks.onScaleChange(clampServings(model.state.displayServings! - 1))}
            >−</button>
            <span class="cook-stepper-val" aria-live="polite">
                <b>{model.state.displayServings}</b> {model.state.displayServings === 1 && !model.settings.servingsLabel ? 'serving' : (model.settings.servingsLabel || 'servings')}
            </span>
            <button
                type="button"
                class="cook-stepper-btn"
                aria-label="More servings"
                disabled={model.state.displayServings >= 1000}
                onclick={() => model.callbacks.onScaleChange(clampServings(model.state.displayServings! + 1))}
            >+</button>
        </div>
    {:else}
        <span class="cook-servings-static" class:is-missing={servingsText === 'Servings not set'}>{servingsText}</span>
    {/if}
</nav>
