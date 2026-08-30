import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import { naive } from './plugins/naive-ui';
import AppLayout from './layouts/AppLayout.vue';
import { clearCurrentUser, currentUser, defaultRouteForUser, setCurrentUser } from './composables/auth';
import { authApi } from './services/auth';
import { setUnauthorizedHandler } from './services/http';
import RatingView from './views/RatingView.vue';
import LoginView from './views/LoginView.vue';
import AdminLayout from './layouts/AdminLayout.vue';
import AdminDashboardView from './views/AdminDashboardView.vue';
import AdminProjectView from './views/AdminProjectView.vue';
import AdminProjectsView from './views/AdminProjectsView.vue';
import AdminSubjectView from './views/AdminSubjectView.vue';
import AdminTaskView from './views/AdminTaskView.vue';
import AdminTaskManagerView from './views/AdminTaskManagerView.vue';
import AdminScoringView from './views/AdminScoringView.vue';
import AdminAccountView from './views/AdminAccountView.vue';
import AdminTeamsView from './views/AdminTeamsView.vue';
import FeedbackView from './views/FeedbackView.vue';
import AdminFeedbackView from './views/AdminFeedbackView.vue';
import './style.css';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: LoginView, meta: { public: true } },
    {
      path: '/',
      component: AdminLayout,
      children: [
        { path: '', component: RatingView },
        { path: 'tasks', redirect: '/' },
        { path: 'feedbacks', component: FeedbackView }
      ]
    },
    {
      path: '/admin',
      component: AdminLayout,
      children: [
        { path: '', component: AdminDashboardView },
        { path: 'packages', component: AdminProjectView },
        { path: 'projects', component: AdminProjectsView },
        { path: 'tasks', component: AdminTaskManagerView },
        { path: 'scoring', component: AdminScoringView },
        { path: 'accounts', component: AdminAccountView },
        { path: 'teams', component: AdminTeamsView },
        { path: 'feedbacks', component: AdminFeedbackView },
        { path: 'projects/:subjectId/tasks', component: AdminTaskView, alias: 'subjects/:subjectId/tasks' },
        { path: 'packages/:subjectId', component: AdminSubjectView, alias: ['subjects/:subjectId', 'projects/:subjectId/images'] }
      ]
    }
  ]
});

setUnauthorizedHandler(async () => {
  const current = router.currentRoute.value;
  if (current.path === '/login') return;
  await router.replace({ path: '/login', query: { redirect: current.fullPath } });
});

router.beforeEach(to => {
  const user = currentUser.value;
  if (to.meta.public) {
    return user ? defaultRouteForUser(user) : true;
  }
  if (!user) {
    return { path: '/login', query: { redirect: to.fullPath } };
  }
  if (user.role === 'admin' && !to.path.startsWith('/admin')) {
    return '/admin';
  }
  if (user.role !== 'admin' && to.path.startsWith('/admin')) {
    return '/';
  }
  return true;
});

async function bootstrap() {
  try {
    const { user } = await authApi.session();
    setCurrentUser(user);
  } catch {
    clearCurrentUser();
  }
  createApp(AppLayout).use(createPinia()).use(naive).use(router).mount('#app');
}

void bootstrap();
