<script lang="ts" setup>


defineOptions({ name: 'WaveBg' });


</script>

<template>
    <div class="wave-background" aria-hidden="true">
        <div class="wave-background-top">
            <svg height="1337" width="1337">
                <defs>
                    <path id="path-1" opacity="1" fill-rule="evenodd"
                        d="M1337,668.5 C1337,1037.455193874239 1037.455193874239,1337 668.5,1337 C523.6725684305388,1337 337,1236 370.50000000000006,1094 C434.03835568300906,824.6732385973953 6.906089672974592e-14,892.6277623047779 0,668.5000000000001 C0,299.5448061257611 299.5448061257609,1.1368683772161603e-13 668.4999999999999,0 C1037.455193874239,0 1337,299.544806125761 1337,668.5Z" />
                    <linearGradient id="linearGradient-2" x1="0.79" y1="0.62" x2="0.21" y2="0.86">
                        <stop offset="0" stop-color="#1ba15a" stop-opacity="1" />
                        <stop offset="1" stop-color="#40b675" stop-opacity="1" />
                    </linearGradient>
                </defs>
                <g opacity="1">
                    <use xlink:href="#path-1" fill="url(#linearGradient-2)" fill-opacity="1" />
                </g>
            </svg>
        </div>
        <div class="wave-background-bottom">
            <svg height="896" width="967.8852157128662">
                <defs>
                    <path id="path-2" opacity="1" fill-rule="evenodd"
                        d="M896,448 C1142.6325445712241,465.5747656464056 695.2579309733121,896 448,896 C200.74206902668806,896 5.684341886080802e-14,695.2579309733121 0,448.0000000000001 C0,200.74206902668806 200.74206902668791,5.684341886080802e-14 447.99999999999994,0 C695.2579309733121,0 475,418 896,448Z" />
                    <linearGradient id="linearGradient-3" x1="0.5" y1="0" x2="0.5" y2="1">
                        <stop offset="0" stop-color="#1ba15a" stop-opacity="1" />
                        <stop offset="1" stop-color="#40b675" stop-opacity="1" />
                    </linearGradient>
                </defs>
                <g opacity="1">
                    <use xlink:href="#path-2" fill="url(#linearGradient-3)" fill-opacity="1" />
                </g>
            </svg>
        </div>
    </div>
</template>

<style scoped>
.wave-background {
    position: fixed;
    inset: 0;
    z-index: 0;
    overflow: hidden;
    pointer-events: none;
    background: var(--app-bg);
    transition: background-color 0.2s ease;
}

.wave-background svg {
    opacity: var(--login-wave-opacity);
}

.wave-background-top,
.wave-background-bottom {
    position: absolute;
}

.wave-background-top {
    top: -900px;
    right: -300px;
}

.wave-background-bottom {
    bottom: -400px;
    left: -200px;
}

@media (max-width: 640px) {
    .wave-background-top {
        top: -1170px;
        right: -100px;
    }

    .wave-background-bottom {
        bottom: -760px;
        left: -100px;
    }
}
</style>
