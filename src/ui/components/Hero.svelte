<script lang="ts">
    import { setIcon, type TFile } from 'obsidian';
    import { buildMetaPills } from '../../utils/heroModel';
    import type { RecipeRenderModel } from '../types';
    import { recipeName } from '../../utils/recipeFiles';
    import RecipeMarks from './RecipeMarks.svelte';
    import { addedTime, shortDate } from '../../importer/recipeDates';

    let { model, mainImage }: { model: RecipeRenderModel; mainImage: TFile | string | null } = $props();
    let title = $derived(model.recipe.title?.trim() || (model.file && recipeName(model.file.path)) || 'Recipe');
    let description = $derived(model.recipe.description?.trim());
    // When the recipe was added (its `added` property), in small text under the title.
    let added = $derived.by(() => {
        const t = addedTime(model.recipe.rawMetadata?.get?.('added'), NaN);
        return Number.isFinite(t) ? shortDate(t, true) : null;
    });
    let allPills = $derived(buildMetaPills(model.recipe, model.state.displayServings));
    // Details (time, servings, source...) on one line, tags on the next.
    let pills = $derived(allPills.filter(pill => pill.kind !== 'tag'));
    let tags = $derived(allPills.filter(pill => pill.kind === 'tag'));
    let canEditTags = $derived(!!(model.interactive && model.file && model.host.editTags));
    /** Puts an Obsidian icon at the start of the element. */
    function icon(node: HTMLElement, name: string) {
        const span = document.createElement('span');
        span.className = 'cook-pill-icon-svg';
        node.prepend(span);
        setIcon(span, name);
        return {
            update(next: string) { span.replaceChildren(); setIcon(span, next); },
            destroy() { span.remove(); },
        };
    }
    // Bumped when the photo file is saved over (Set recipe photo keeps its name), so the new picture shows.
    let photoVersion = $state(0);
    $effect(() => {
        const file = mainImage;
        if (!file || typeof file === 'string' || !model.host.watchFile) return;
        return model.host.watchFile(file, () => photoVersion++);
    });
    let mainImageUrl = $derived.by(() => {
        void photoVersion;
        return typeof mainImage === 'string' ? mainImage : mainImage ? model.host.getResourcePath(mainImage) : null;
    });
</script>

<header class="cook-hero">
    <div class="cook-hero-body">
        <h1 class="cook-hero-title">{title}</h1>
        {#if added}
            <div class="cook-hero-added">Added {added}</div>
        {/if}
        {#if description}
            <p class="cook-hero-desc">{description}</p>
        {/if}
        {#if pills.length}
            <div class="cook-pills" aria-label="Recipe information">
                {#each pills as pill}
                    {#if pill.url && (pill.kind === 'source' || pill.kind === 'author')}
                        <a
                            class="cook-pill"
                            href={pill.url}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            {#if pill.icon}<span class="cook-pill-icon" aria-hidden="true">{pill.icon}</span>{/if}
                            {pill.text}
                        </a>
                    {:else}
                        <span class="cook-pill">
                            {#if pill.icon}<span class="cook-pill-icon" aria-hidden="true">{pill.icon}</span>{/if}
                            {pill.text}
                        </span>
                    {/if}
                {/each}
            </div>
        {/if}
        {#if tags.length || canEditTags}
            <div class="cook-pills cook-tags" aria-label="Tags">
                {#each tags as pill}
                    {#if model.interactive && model.host.searchTag}
                        <button
                            type="button"
                            class="cook-pill cook-pill-tag is-clickable"
                            aria-label={`Search for ${pill.text}`}
                            onclick={() => model.host.searchTag?.(pill.text.replace(/^#/, ''))}
                        >{pill.text}</button>
                    {:else}
                        <span class="cook-pill cook-pill-tag">{pill.text}</span>
                    {/if}
                {/each}
                {#if canEditTags}
                    <button
                        type="button"
                        class="cook-pill cook-pill-edit-tags is-clickable"
                        aria-label={tags.length ? 'Edit tags' : 'Add tags'}
                        title={tags.length ? 'Edit tags' : 'Add tags'}
                        onclick={() => model.file && model.host.editTags?.(model.file)}
                        use:icon={tags.length ? 'pencil' : 'plus'}
                    >{#if !tags.length}<span>Add tags</span>{/if}</button>
                {/if}
            </div>
        {/if}
        <RecipeMarks {model} />
    </div>

    {#if model.settings.showImages && mainImageUrl}
        <figure class="cook-hero-image">
            <img src={mainImageUrl} alt={`${title} recipe`} />
        </figure>
    {/if}
</header>
