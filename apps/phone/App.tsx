import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

/**
 * 应用根组件 — 展示 Hello World 起始页
 *
 * 作为 Expo 应用的入口界面，居中显示欢迎文案，
 * 后续业务页面可在此基础上扩展。
 *
 * @returns Hello World 页面
 */
export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Hello World</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 28,
    fontWeight: '600',
  },
});
