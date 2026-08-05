import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import { naive } from './plugins/naive-ui';
import AppLayout from './layouts/AppLayout.vue';
import RatingView from './views/RatingView.vue';
import AdminView from './views/AdminView.vue';
import AdminSubjectView from './views/AdminSubjectView.vue';
import './style.css';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: RatingView },
    { path: '/admin', component: AdminView },
    { path: '/admin/subjects/:subjectId', component: AdminSubjectView }
  ]
});

createApp(AppLayout).use(naive).use(router).mount('#app');
