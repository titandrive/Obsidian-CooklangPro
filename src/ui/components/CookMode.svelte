<script lang="ts">
    // Cook mode: the recipe one step at a time, in big type, over the recipe's tab (the whole screen on a phone).
    // It shares the recipe view's state: the same scaled amounts, ingredient checkmarks, current step and timers
    // (timer keys match MethodSteps, so a timer started here keeps running in the recipe and back).
    import { onMount, tick } from 'svelte';
    import { Platform, setIcon } from 'obsidian';
    import { cookware_display_name, ingredient_display_name, quantity_display } from '../../recipeHelpers';
    import { getSections, type StepPart as Part } from '../../utils/sectionHelpers';
    import {
        createUnitMap,
        DEFAULT_HOURS_LABELS,
        DEFAULT_MINUTES_LABELS,
        DEFAULT_SECONDS_LABELS,
        formatTimerDuration,
        timerDurationFromQuantity,
    } from '../../utils/timeFormatters';
    import type { RecipeRenderModel } from '../types';
    import IngredientList from './IngredientList.svelte';
    import StepPart from './StepPart.svelte';

    let { model, title }: { model: RecipeRenderModel; title: string } = $props();

    let steps = $derived(getSections(model.recipe).flatMap(section =>
        section.entries.flatMap(entry => entry.type === 'step' ? [{ step: entry.step, section: section.name }] : [])));
    let index = $derived(Math.min(Math.max(model.state.currentStep, 0), Math.max(steps.length - 1, 0)));
    let current = $derived(steps[index]);
    let next = $derived(steps[index + 1] ?? null);
    let last = $derived(index >= steps.length - 1);
    let unitMap = $derived(createUnitMap(
        model.settings.minutesLabel || DEFAULT_MINUTES_LABELS,
        model.settings.hoursLabel || DEFAULT_HOURS_LABELS,
        model.settings.secondsLabel || DEFAULT_SECONDS_LABELS,
    ));
    // A step's ingredients, once each, with this scale's amounts.
    let stepIngredients = $derived.by(() => {
        const seen = new Map<string, { name: string; qty: string; note: string }>();
        for (const part of current?.step.parts ?? []) {
            if (part.type !== 'ingredient') continue;
            const name = ingredient_display_name(part.ingredient);
            const qty = part.ingredient.quantity ? quantity_display(part.ingredient.quantity) : '';
            const note = part.ingredient.note?.trim() ?? '';
            const had = seen.get(name);
            if (had) {
                if (qty) had.qty = had.qty ? `${had.qty} + ${qty}` : qty;
            } else seen.set(name, { name, qty, note });
        }
        return [...seen.values()];
    });
    let showAll = $state(false);
    let root = $state<HTMLElement>();
    let wakeLock: { release(): Promise<void> } | null = null;
    let awake = $state(false);

    /** The step as plain text, for the "Next" card. */
    function plain(parts: Part[]): string {
        return parts.map(part => {
            if (part.type === 'text') return part.value;
            if (part.type === 'ingredient') return ingredient_display_name(part.ingredient);
            if (part.type === 'cookware') return cookware_display_name(part.cookware);
            if (part.type === 'inlineQuantity') return quantity_display(part.quantity);
            const d = timerDurationFromQuantity(part.timer.quantity, unitMap);
            return d ? formatTimerDuration(d) : (part.timer.name ?? '');
        }).join('').replace(/\s+/g, ' ').trim();
    }

    function go(to: number) {
        if (to < 0 || to >= steps.length || to === index) return;
        model.callbacks.onStepSet?.(to);
        showAll = false;
    }

    function close() {
        model.callbacks.onCookMode?.(false);
    }

    function icon(node: HTMLElement, name: string) {
        setIcon(node, name);
        return { update: (n: string) => { node.empty(); setIcon(node, n); } };
    }

    /** Over the recipe's tab, not inside its scrolling content. */
    function portal(node: HTMLElement) {
        const host = node.closest<HTMLElement>('.workspace-leaf-content') ?? document.body;
        host.appendChild(node);
        return { destroy: () => node.remove() };
    }

    // Swipe left or right between steps (not over buttons, or while a timer slider is open).
    let start: { x: number; y: number } | null = null;
    function pointerDown(e: PointerEvent) {
        if (e.pointerType === 'mouse' || (e.target as Element).closest('button, input, label, a, .cook-timer-range-popover')) return;
        start = { x: e.clientX, y: e.clientY };
    }
    function pointerUp(e: PointerEvent) {
        if (!start) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        start = null;
        if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        go(dx < 0 ? index + 1 : index - 1);
    }

    // Space or → next, ← back, Enter shows or hides every ingredient, Esc closes. They win over a focused button
    // (so Space after clicking Next goes on, not clicks it again); a checkbox or timer slider keeps its own keys.
    function keydown(e: KeyboardEvent) {
        if ((e.target as Element).closest('input[type="range"], .cook-timer-range-popover')) return;
        const onCheckbox = !!(e.target as Element).closest('input[type="checkbox"]');
        if (e.key === ' ' && !onCheckbox) {
            e.preventDefault();
            go(index + 1);
        } else if (e.key === 'Enter' && !onCheckbox) {
            e.preventDefault();
            showAll = !showAll;
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown') {
            e.preventDefault();
            go(index + 1);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') {
            e.preventDefault();
            go(index - 1);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close();
        }
    }

    // Keep the screen on while cooking, where the device allows it; asked again when the app comes back.
    async function stayAwake() {
        const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
        if (!nav.wakeLock || document.visibilityState !== 'visible') return;
        try {
            wakeLock = await nav.wakeLock.request('screen');
            awake = true;
        } catch {
            awake = false;
        }
    }

    onMount(() => {
        if (model.state.currentStep < 0 && steps.length) model.callbacks.onStepSet?.(0);
        void stayAwake();
        // On a phone, cook mode takes the whole screen: Obsidian's bottom bar and toolbar are hidden while it's open.
        document.body.addClass('cooklang-cooking');
        const visible = () => { if (document.visibilityState === 'visible') void stayAwake(); };
        document.addEventListener('visibilitychange', visible);
        void tick().then(() => root?.focus({ preventScroll: true }));
        return () => {
            document.removeEventListener('visibilitychange', visible);
            document.body.removeClass('cooklang-cooking');
            void wakeLock?.release().catch(() => {});
            wakeLock = null;
        };
    });

    function stepNode(node: HTMLElement, _key: number) {
        // A new step starts at the top.
        return { update: () => node.scrollTo({ top: 0 }) };
    }
</script>

<div
    bind:this={root}
    use:portal
    class="cook-mode"
    role="dialog"
    aria-modal="true"
    aria-label={`Cook mode: ${title}`}
    tabindex="-1"
    onkeydown={keydown}
>
    <header class="cook-mode-head">
        <div class="cook-mode-title">
            <span class="cook-mode-recipe">{title}</span>
            <span class="cook-mode-where">
                {`${current?.section ? `${current.section} · ` : ''}Step ${index + 1} of ${steps.length}`}
            </span>
        </div>
        <button type="button" class="clickable-icon cook-mode-close" aria-label="Close cook mode" onclick={close} use:icon={'x'}></button>
    </header>
    <div class="cook-mode-progress" aria-hidden="true">
        <div class="cook-mode-progress-bar" style={`width: ${steps.length ? ((index + 1) / steps.length) * 100 : 0}%`}></div>
    </div>

    <div class="cook-mode-body" role="region" aria-label="Current step" use:stepNode={index} onpointerdown={pointerDown} onpointerup={pointerUp}>
        {#if current}
            <p class="cook-mode-step">
                {#each current.step.parts as part, partIndex}
                    <StepPart
                        {model}
                        {part}
                        {unitMap}
                        timerKey={`${model.instanceId}:step-${current.step.globalIndex}:part-${partIndex}`}
                    />
                {/each}
            </p>

            {#if stepIngredients.length}
                <section class="cook-mode-ings" aria-label="Ingredients for this step">
                    <h3 class="cook-mode-label">For this step</h3>
                    <ul>
                        {#each stepIngredients as ing}
                            {@const checked = model.state.checkedIngredients.has(ing.name)}
                            <li class:done={checked}>
                                <label>
                                    <input
                                        type="checkbox"
                                        {checked}
                                        onchange={() => model.callbacks.onIngredientToggle(ing.name)}
                                    />
                                    <span class="cook-mode-ing-name">{ing.name}{#if ing.note}<span class="cook-mode-ing-note">, {ing.note}</span>{/if}</span>
                                    {#if ing.qty}<span class="cook-mode-ing-qty">{ing.qty}</span>{/if}
                                </label>
                            </li>
                        {/each}
                    </ul>
                </section>
            {/if}

            <button type="button" class="cook-mode-all" aria-expanded={showAll} onclick={() => (showAll = !showAll)}>
                <span use:icon={showAll ? 'chevron-down' : 'chevron-right'}></span>
                {showAll ? 'Hide all ingredients' : 'Show all ingredients'}
            </button>
            {#if showAll}
                <div class="cook-mode-all-list"><IngredientList {model} /></div>
            {/if}
        {:else}
            <p class="cook-mode-empty">This recipe has no steps.</p>
        {/if}
    </div>

    <footer class="cook-mode-foot">
        {#if next}
            <button type="button" class="cook-mode-next-card" onclick={() => go(index + 1)} aria-label="Go to the next step">
                <span class="cook-mode-label">Next{#if next.section && next.section !== current?.section} · {next.section}{/if}</span>
                <span class="cook-mode-next-text">{plain(next.step.parts)}</span>
            </button>
        {/if}
        <div class="cook-mode-buttons">
            <button type="button" class="cook-mode-back" disabled={index === 0} onclick={() => go(index - 1)}>
                <span use:icon={'arrow-left'}></span>Back
            </button>
            {#if last}
                <button type="button" class="mod-cta cook-mode-forward" onclick={close}>
                    <span use:icon={'check'}></span>Done
                </button>
            {:else}
                <button type="button" class="mod-cta cook-mode-forward" onclick={() => go(index + 1)}>
                    Next<span use:icon={'arrow-right'}></span>
                </button>
            {/if}
        </div>
        {#if !Platform.isMobile}
            <div class="cook-mode-awake">Space next · ← back · Enter all ingredients · Esc close{#if awake} · Screen stays on{/if}</div>
        {:else if awake}
            <div class="cook-mode-awake">Screen stays on while cooking</div>
        {/if}
    </footer>
</div>
